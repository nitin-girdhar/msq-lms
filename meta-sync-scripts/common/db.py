"""Postgres connection helper.

Connects as the crm_service role (DATABASE_URL_SERVICE) — the same
BYPASSRLS service role the Node services use via withServiceTx(). Because
RLS is bypassed, every query in this package passes org_id/tenant_id
explicitly rather than relying on session GUCs.
"""

from contextlib import contextmanager

import psycopg2
import psycopg2.extras

from . import config


def get_connection():
    return psycopg2.connect(config.DATABASE_URL_SERVICE)


@contextmanager
def transaction():
    """Yields a dict-cursor inside a single transaction; commits on success,
    rolls back on any exception."""
    conn = get_connection()
    try:
        with conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                yield cur
    finally:
        conn.close()


@contextmanager
def read_only_cursor():
    conn = get_connection()
    conn.set_session(readonly=True, autocommit=True)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            yield cur
    finally:
        conn.close()
