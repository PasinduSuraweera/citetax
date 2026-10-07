"""Database access. Supabase Postgres 16 + pgvector.

citetax-api should be granted SELECT only, and only on the published-only views
(spec §2.3), so it is structurally incapable of serving an unreviewed rule.
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import OperationalError

from app.core.config import get_settings

_engine: Engine | None = None
logger = logging.getLogger(__name__)

# The pooler's hostname sometimes fails to resolve for a moment on this
# network. That is worth a couple of quick retries, not a failed request.
_TRANSIENT = ("getaddrinfo", "could not translate host name", "temporary failure in name resolution")
_RETRY_DELAYS = (0.4, 1.2)


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        settings = get_settings()
        if not settings.database_url:
            raise RuntimeError(
                "DATABASE_URL is not set. Copy .env.example to .env and paste your "
                "Supabase connection string."
            )
        _engine = create_engine(
            settings.database_url,
            pool_size=5,
            max_overflow=5,
            pool_pre_ping=True,   # Supabase drops idle connections
            pool_recycle=300,
        )
    return _engine


def _connect() -> Connection:
    for delay in (*_RETRY_DELAYS, None):
        try:
            return get_engine().connect()
        except OperationalError as exc:
            if delay is None or not any(t in str(exc).lower() for t in _TRANSIENT):
                raise
            logger.warning("database connect failed on a name lookup; retrying in %.1fs", delay)
            time.sleep(delay)
    raise AssertionError("unreachable")


@contextmanager
def db_conn() -> Iterator[Connection]:
    with _connect() as conn:
        yield conn


def db_healthy() -> tuple[bool, str]:
    """Used by /health so a misconfigured database is visible immediately
    rather than as a 500 on the first question."""
    try:
        with db_conn() as conn:
            conn.execute(text("select 1"))
        return True, "ok"
    except Exception as exc:  # noqa: BLE001 — surfaced to an operator, not a user
        return False, str(exc)[:200]
