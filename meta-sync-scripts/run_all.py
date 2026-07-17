#!/usr/bin/env python3
"""Orchestrates the full sync in order: forms -> campaigns -> leads.

Intended as a single cron entry. Each stage is idempotent on its own (see
sync_forms.py / sync_campaigns.py / sync_leads.py), and running them in this
order matters: forms discovery keeps org mappings current, campaign sync
makes campaign_id resolvable, then lead sync can attribute new leads to the
right org and campaign in one pass.

Just forwards --tenant-id/--org-id/--dry-run/--debug to each stage; runs
each as a subprocess so a failure in one stage is isolated and reported
without aborting the others.
"""

import argparse
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def run_stage(script: str, args: argparse.Namespace, supports_org_id: bool = True) -> int:
    cmd = [sys.executable, str(SCRIPT_DIR / script)]
    if args.tenant_id:
        cmd += ["--tenant-id", args.tenant_id]
    if supports_org_id and args.org_id:
        cmd += ["--org-id", args.org_id]
    if args.dry_run:
        cmd += ["--dry-run"]
    if args.debug:
        cmd += ["--debug"]

    print(f"\n=== running {script} ===", flush=True)
    result = subprocess.run(cmd)
    return result.returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant-id", help="Only sync this tenant (UUID)")
    parser.add_argument("--org-id", help="Only sync this org (UUID) — applies to campaigns/leads stages only")
    parser.add_argument("--dry-run", action="store_true", help="Log what would happen, write nothing (no DB, no CSV)")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Redirect every write across all stages to CSV files under output/ instead of the database",
    )
    args = parser.parse_args()

    exit_code = 0
    exit_code |= run_stage("sync_forms.py", args, supports_org_id=False)
    exit_code |= run_stage("sync_campaigns.py", args)
    exit_code |= run_stage("sync_leads.py", args)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
