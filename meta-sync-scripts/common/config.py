import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
# .env.local (gitignored, real local/remote credentials) takes precedence
# over .env (template-ish defaults), same convention as apps/web/.env.local.
load_dotenv(_ROOT / ".env")
load_dotenv(_ROOT / ".env.local", override=True)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"[meta-sync-scripts] Missing required env var: {name}")
    return value


DATABASE_URL_SERVICE = _require_env("DATABASE_URL_SERVICE")
META_ENCRYPTION_KEY = os.environ.get("META_ENCRYPTION_KEY") or None
DEFAULT_GRAPH_API_VERSION = os.environ.get("META_GRAPH_API_VERSION", "v21.0")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()


def setup_logging(name: str) -> logging.Logger:
    logging.basicConfig(
        level=LOG_LEVEL,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    return logging.getLogger(name)
