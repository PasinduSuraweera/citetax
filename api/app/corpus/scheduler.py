"""The corpus agent: runs on its own, on a timer, and does everything up to the
point a human has to decide.

One cycle:
  1. crawl every enabled source, recording new documents and silent revisions
  2. extract text from anything that arrived without it
  3. run the LLM extractor on documents that have a blank placeholder proposal,
     so the inbox fills with pre-filled proposals rather than empty rows
  4. index new text into the retrieval store, and re-index rule text when it
     no longer matches the current snapshot
  5. write an agent_cycle row so the admin panel can show what the agent did

What it never does: approve, publish, or touch rule_version. Human authority is
the product (spec section 1.1, property 3).

APScheduler runs inside the API process for this build. In production this is
a Cloud Run Job on Cloud Scheduler; the cycle function is the same either way.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text

from app.core import llm
from app.core.config import get_settings
from app.corpus import extractor, watcher
from app.db.session import db_conn
from app.retrieval import indexer

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_scheduler = None
_last_cycle: dict[str, Any] | None = None


@dataclass
class CycleReport:
    id: str
    trigger: str
    started_at: str
    finished_at: str | None = None
    crawled_sources: int = 0
    new_documents: int = 0
    revisions: int = 0
    extracted_documents: int = 0
    proposals_created: int = 0
    chunks_indexed: int = 0
    llm_tokens: int = 0
    errors: list[str] = field(default_factory=list)
    summary: str = ""

    def to_json(self) -> dict[str, Any]:
        return self.__dict__.copy()


def run_cycle(trigger: str = "scheduler") -> CycleReport:
    """One full pass. Safe to call concurrently: a second caller waits."""
    global _last_cycle
    if not _lock.acquire(blocking=False):
        # A cycle is already running. Report that rather than stacking up.
        return CycleReport(
            id="busy", trigger=trigger,
            started_at=datetime.now(timezone.utc).isoformat(),
            summary="a cycle is already running",
        )

    report = CycleReport(
        id=str(uuid.uuid4()), trigger=trigger,
        started_at=datetime.now(timezone.utc).isoformat(),
    )
    budget = llm.LLMBudget()

    try:
        with db_conn() as conn:
            conn.execute(
                text(
                    "insert into agent_cycle (id, trigger, started_at) "
                    "values (:id, :t, now())"
                ),
                {"id": report.id, "t": trigger},
            )
            conn.commit()

            # 1. crawl
            try:
                results = watcher.watch_all(conn)
                report.crawled_sources = len(results)
                report.new_documents = sum(r.new_documents for r in results)
                report.revisions = sum(r.revisions for r in results)
                for r in results:
                    report.errors.extend(f"{r.source_id}: {e}" for e in r.errors[:2])
            except Exception as exc:  # noqa: BLE001
                conn.rollback()
                report.errors.append(f"crawl: {str(exc)[:160]}")

            # 2 and 3. extract
            try:
                ex = extractor.extract_pending(conn, limit=6, budget=budget)
                report.extracted_documents = sum(
                    1 for e in ex if e.error is None and e.skipped_reason is None
                )
                report.proposals_created = sum(
                    e.proposals_created + e.proposals_updated for e in ex
                )
                report.errors.extend(
                    f"extract {e.document_id[:8]}: {e.error}" for e in ex if e.error
                )
            except Exception as exc:  # noqa: BLE001
                conn.rollback()
                report.errors.append(f"extract: {str(exc)[:160]}")

            # 4. index
            try:
                # Publish and rollback re-index straight away; this catches a
                # re-index that failed there, and any other change of snapshot.
                if indexer.rule_index_is_stale(conn):
                    ir = indexer.index_rule_versions(conn)
                    report.chunks_indexed += ir.chunks_written
                    report.errors.extend(f"rule text: {e}" for e in ir.errors[:2])
                ir2 = indexer.index_unindexed_documents(conn, limit=10)
                report.chunks_indexed += ir2.chunks_written
                report.errors.extend(ir2.errors[:3])
            except Exception as exc:  # noqa: BLE001
                conn.rollback()
                report.errors.append(f"index: {str(exc)[:160]}")

            report.llm_tokens = budget.total_tokens
            report.finished_at = datetime.now(timezone.utc).isoformat()
            report.summary = _summarise(report)

            conn.execute(
                text(
                    "update agent_cycle set finished_at = now(), crawled_sources = :c, "
                    "new_documents = :n, revisions = :r, extracted_documents = :x, "
                    "proposals_created = :p, chunks_indexed = :i, llm_tokens = :tok, "
                    "errors = cast(:e as jsonb), summary = :s where id = :id"
                ),
                {
                    "c": report.crawled_sources, "n": report.new_documents,
                    "r": report.revisions, "x": report.extracted_documents,
                    "p": report.proposals_created, "i": report.chunks_indexed,
                    "tok": report.llm_tokens,
                    "e": json.dumps(report.errors[:20]), "s": report.summary,
                    "id": report.id,
                },
            )
            conn.commit()
    except Exception as exc:  # noqa: BLE001
        report.errors.append(f"cycle: {str(exc)[:200]}")
        report.finished_at = datetime.now(timezone.utc).isoformat()
        report.summary = "cycle failed: " + str(exc)[:120]
        logger.exception("agent cycle failed")
    finally:
        _last_cycle = report.to_json()
        _lock.release()

    return report


def _summarise(r: CycleReport) -> str:
    bits = []
    if r.revisions:
        bits.append(f"{r.revisions} silent revision{'s' if r.revisions != 1 else ''} detected")
    if r.new_documents:
        bits.append(f"{r.new_documents} new document{'s' if r.new_documents != 1 else ''}")
    if r.proposals_created:
        bits.append(f"{r.proposals_created} proposal{'s' if r.proposals_created != 1 else ''} pre-filled")
    if r.chunks_indexed:
        bits.append(f"{r.chunks_indexed} passages indexed")
    if not bits:
        bits.append("nothing changed at any source")
    if r.errors:
        bits.append(f"{len(r.errors)} error{'s' if len(r.errors) != 1 else ''}")
    return "; ".join(bits)


def start() -> None:
    """Start the background scheduler. Idempotent."""
    global _scheduler
    settings = get_settings()
    if _scheduler is not None or settings.watch_interval_minutes <= 0:
        return
    try:
        from apscheduler.schedulers.background import BackgroundScheduler

        _scheduler = BackgroundScheduler(timezone="UTC")
        _scheduler.add_job(
            run_cycle, "interval",
            minutes=settings.watch_interval_minutes,
            id="corpus-agent", replace_existing=True,
            kwargs={"trigger": "scheduler"},
            max_instances=1, coalesce=True,
        )
        _scheduler.start()
        logger.info(
            "corpus agent scheduled every %d min", settings.watch_interval_minutes
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("scheduler failed to start: %s", exc)
        _scheduler = None


def stop() -> None:
    global _scheduler
    if _scheduler is not None:
        try:
            _scheduler.shutdown(wait=False)
        finally:
            _scheduler = None


def status() -> dict[str, Any]:
    settings = get_settings()
    next_run = None
    if _scheduler is not None:
        job = _scheduler.get_job("corpus-agent")
        if job and job.next_run_time:
            next_run = job.next_run_time.isoformat()
    return {
        "enabled": _scheduler is not None,
        "interval_minutes": settings.watch_interval_minutes,
        "next_run_at": next_run,
        "running_now": _lock.locked(),
        "last_cycle": _last_cycle,
    }
