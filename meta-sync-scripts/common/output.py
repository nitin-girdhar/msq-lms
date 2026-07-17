"""CSV output for --debug mode.

When a script is run with --debug, every DB write is redirected here instead
of being executed against Postgres — reads (dedup checks, org/campaign
resolution, tenant config) still hit the real DB so the preview reflects
current state, but nothing is persisted. Each named CSV is truncated
(overwritten) at the start of a run, then appended to for the rest of that
run, so a re-run's output/*.csv always reflects only the most recent run.
"""

import csv
from pathlib import Path
from typing import Any, Dict

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"


class CsvWriter:
    _open_this_run: set = set()

    def __init__(self, name: str):
        self.path = OUTPUT_DIR / f"{name}.csv"
        self._fh = None
        self._writer = None

    def write(self, row: Dict[str, Any]) -> None:
        if self._writer is None:
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
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
