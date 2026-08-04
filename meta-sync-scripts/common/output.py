"""File output under output/ — CSV previews and raw JSON dumps.

Two distinct uses:

1. `--debug` mode on the sync scripts: every DB write is redirected here
   instead of being executed against Postgres — reads (dedup checks,
   org/campaign resolution, tenant config) still hit the real DB so the
   preview reflects current state, but nothing is persisted. Each named CSV
   is truncated (overwritten) at the start of a run, then appended to for the
   rest of that run.

2. The download -> check -> import workflow: download_page_leads.py writes a
   timestamped run directory (output/run_<ts>/) holding the verbatim Graph
   payloads plus review CSVs; check_leads_against_db.py and
   import_downloaded_leads.py read that same directory back, so what you
   reviewed is exactly what gets imported. output/latest always points at the
   most recent download run (a copy of its name, not a symlink — Windows).
"""

import csv
import json
from pathlib import Path
from typing import Any, Dict, Optional

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"
LATEST_POINTER = OUTPUT_DIR / "latest.txt"


def new_run_dir(prefix: str = "run") -> Path:
    """Creates output/<prefix>_<UTC timestamp>/ and records it as the latest
    run so the check/import stages can find it without being told."""
    from datetime import datetime, timezone

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = OUTPUT_DIR / f"{prefix}_{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)
    LATEST_POINTER.write_text(run_dir.name, encoding="utf-8")
    return run_dir


def resolve_run_dir(explicit: Optional[str] = None) -> Path:
    """Resolves the run directory the check/import stages should read:
    an explicit --run-dir (absolute, or a name under output/), else whatever
    the last download run recorded in output/latest.txt."""
    if explicit:
        candidate = Path(explicit)
        if not candidate.is_absolute():
            candidate = OUTPUT_DIR / explicit
        if not candidate.is_dir():
            raise FileNotFoundError(f"Run directory not found: {candidate}")
        return candidate

    if not LATEST_POINTER.exists():
        raise FileNotFoundError(
            f"No previous download run found ({LATEST_POINTER} is missing) — "
            "run download_page_leads.py first, or pass --run-dir"
        )
    run_dir = OUTPUT_DIR / LATEST_POINTER.read_text(encoding="utf-8").strip()
    if not run_dir.is_dir():
        raise FileNotFoundError(f"Run directory recorded in latest.txt no longer exists: {run_dir}")
    return run_dir


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str), encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


class CsvWriter:
    _open_this_run: set = set()

    def __init__(self, name: str, run_dir: Optional[Path] = None):
        self.path = (run_dir or OUTPUT_DIR) / f"{name}.csv"
        self._fh = None
        self._writer = None

    def write(self, row: Dict[str, Any]) -> None:
        if self._writer is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # First write from this file this run -> overwrite; later writes -> append.
            mode = "w" if self.path not in CsvWriter._open_this_run else "a"
            CsvWriter._open_this_run.add(self.path)
            write_header = mode == "w"
            self._fh = open(self.path, mode, newline="", encoding="utf-8")
            self._writer = csv.DictWriter(self._fh, fieldnames=list(row.keys()))
            if write_header:
                self._writer.writeheader()
        self._writer.writerow(row)

    def close(self) -> None:
        if self._fh:
            self._fh.close()
            self._fh = None
            self._writer = None

    def __enter__(self) -> "CsvWriter":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()
