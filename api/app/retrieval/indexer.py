"""Chunk and embed documents into the chunk table.

Two kinds of text get indexed:
  1. The quoted_text on every published rule version, tagged with its rule_key.
     This is the highest value passage: it is the exact sentence a figure came
     from, already reviewer approved.
  2. The raw_text of source documents (crawled pages, uploaded files), so a
     general question can be answered from the law rather than from the model.

Idempotent per document: existing chunks for a document are replaced. Records
embedding_model and dim on every row so a partial re-index is detectable.
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.retrieval import embeddings
from app.retrieval.chunker import chunk_text

logger = logging.getLogger(__name__)


@dataclass
class IndexReport:
    documents: int = 0
    rule_versions: int = 0
    chunks_written: int = 0
    embedded: int = 0
    skipped: int = 0
    removed: int = 0
    errors: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return self.__dict__.copy()


def _vec_literal(v: list[float]) -> str | None:
    if not v:
        return None
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def _write_chunks(
    conn: Connection,
    doc_id: str | None,
    rule_key: str | None,
    texts: list[str],
    provider: embeddings.EmbeddingProvider,
    report: IndexReport,
) -> None:
    if not texts:
        return
    vectors: list[list[float]] = [[] for _ in texts]
    if embeddings.dense_enabled():
        try:
            vectors = provider.embed_documents(texts)
            report.embedded += len(vectors)
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"embed failed: {str(exc)[:140]}")

    for body, vec in zip(texts, vectors):
        conn.execute(
            text(
                "insert into chunk (id, source_document_id, rule_key, text, "
                "embedding, embedding_model, embedding_dim, indexed_at, status) "
                "values (:id, :doc, :key, :t, cast(:v as vector), :m, :d, now(), "
                "'published')"
            ),
            {
                "id": str(uuid.uuid4()),
                "doc": doc_id,
                "key": rule_key,
                "t": body,
                "v": _vec_literal(vec),
                "m": provider.model_id if vec else None,
                "d": provider.dim if vec else None,
            },
        )
        report.chunks_written += 1


def index_rule_versions(conn: Connection, report: IndexReport | None = None) -> IndexReport:
    """Index the quoted text of every published rule version."""
    report = report or IndexReport()
    provider = embeddings.get_provider()

    rows = conn.execute(
        text(
            "select rv.id, rv.rule_key, rv.quoted_text, rv.citation_label, "
            "       rv.source_document_id "
            "  from rule_version rv where rv.status = 'published' "
            "   and rv.quoted_text is not null"
        )
    ).mappings().all()

    # Replace prior rule text chunks wholesale: they are cheap and few.
    conn.execute(
        text("delete from chunk where rule_key is not null and source_document_id is null")
    )

    texts, keys = [], []
    for r in rows:
        body = f"{r['citation_label'] or r['rule_key']}: {r['quoted_text']}"
        texts.append(body)
        keys.append(r["rule_key"])
        report.rule_versions += 1

    # One embedding call for all rule texts, then write per key.
    vectors: list[list[float]] = [[] for _ in texts]
    if texts and embeddings.dense_enabled():
        try:
            vectors = provider.embed_documents(texts)
            report.embedded += len(vectors)
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"embed failed: {str(exc)[:140]}")

    for body, key, vec in zip(texts, keys, vectors):
        conn.execute(
            text(
                "insert into chunk (id, source_document_id, rule_key, text, "
                "embedding, embedding_model, embedding_dim, indexed_at, status) "
                "values (:id, null, :key, :t, cast(:v as vector), :m, :d, now(), "
                "'published')"
            ),
            {
                "id": str(uuid.uuid4()), "key": key, "t": body,
                "v": _vec_literal(vec),
                "m": provider.model_id if vec else None,
                "d": provider.dim if vec else None,
            },
        )
        report.chunks_written += 1

    conn.commit()
    return report


# A line on this share of a site's pages is its template: menus, sidebar,
# footer. Stored text is all that is kept of a page, so the template is found
# by comparing pages rather than by reading the HTML.
BOILERPLATE_SHARE = 0.3
BOILERPLATE_MIN_PAGES = 5


def _host(url: str | None) -> str:
    return (urlparse(url or "").hostname or "").lower()


def boilerplate_lines(conn: Connection, host: str) -> set[str]:
    """Lines repeated across a site's pages. Empty for a site with too few
    pages to tell template from content."""
    if not host:
        return set()
    rows = conn.execute(
        text(
            "select distinct on (url) raw_text from source_document "
            " where raw_text is not null and url like :pat "
            " order by url, revision_no desc"
        ),
        {"pat": f"%://{host}/%"},
    ).scalars().all()
    if len(rows) < BOILERPLATE_MIN_PAGES:
        return set()
    counts: Counter[str] = Counter()
    for raw in rows:
        counts.update({ln.strip() for ln in raw.split("\n") if ln.strip()})
    threshold = max(3, int(BOILERPLATE_SHARE * len(rows)))
    return {ln for ln, c in counts.items() if c >= threshold}


def strip_boilerplate(raw: str, boiler: set[str]) -> str:
    if not boiler:
        return raw
    return "\n".join(ln for ln in raw.split("\n") if ln.strip() not in boiler)


def index_document(
    conn: Connection,
    doc_id: str,
    report: IndexReport | None = None,
    boiler_cache: dict[str, set[str]] | None = None,
) -> IndexReport:
    """Chunk and embed one source document's raw text, less its site's template."""
    report = report or IndexReport()
    provider = embeddings.get_provider()

    row = conn.execute(
        text("select id, url, raw_text from source_document where id = :id"), {"id": doc_id}
    ).mappings().first()
    if not row or not row["raw_text"]:
        report.skipped += 1
        return report

    host = _host(row["url"])
    cache = boiler_cache if boiler_cache is not None else {}
    if host not in cache:
        cache[host] = boilerplate_lines(conn, host)
    body = strip_boilerplate(row["raw_text"], cache[host])

    conn.execute(text("delete from chunk where source_document_id = :id"), {"id": doc_id})
    pieces = chunk_text(body)
    _write_chunks(conn, doc_id, None, [p.text for p in pieces], provider, report)
    report.documents += 1
    conn.commit()
    return report


# Only the newest revision of a document is searchable. Older revisions stay in
# source_document for the audit trail, but their text is not the law any more.
_LATEST = (
    "not exists (select 1 from source_document n "
    "             where n.family_id = d.family_id and n.revision_no > d.revision_no)"
)
# Listings and script-loaded pages are menus and sidebars, not content.
_NOT_LISTING = (
    "(coalesce((d.text_meta->>'link_share')::float, 0) < 0.9 "
    " and not coalesce((d.text_meta->>'listing')::boolean, false))"
)


def drop_superseded_chunks(conn: Connection) -> int:
    """Remove passages from revisions a newer revision replaced, and from
    listing pages. Returns how many were removed."""
    n = conn.execute(
        text(
            "delete from chunk c using source_document d "
            f" where c.source_document_id = d.id and (not {_LATEST} or not {_NOT_LISTING})"
        )
    ).rowcount
    conn.commit()
    return n


def index_unindexed_documents(conn: Connection, limit: int = 20) -> IndexReport:
    """Documents with text that have no chunks yet. Called by the scheduler."""
    report = IndexReport()
    report.removed = drop_superseded_chunks(conn)
    ids = conn.execute(
        text(
            "select d.id from source_document d "
            " where d.raw_text is not null and length(d.raw_text) > 200 "
            f"  and {_LATEST} and {_NOT_LISTING} "
            "   and not exists (select 1 from chunk c where c.source_document_id = d.id) "
            " order by d.fetched_at desc limit :n"
        ),
        {"n": limit},
    ).scalars().all()
    cache: dict[str, set[str]] = {}
    for doc_id in ids:
        try:
            index_document(conn, str(doc_id), report, cache)
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            report.errors.append(f"{doc_id}: {str(exc)[:140]}")
    return report


def rebuild_all(conn: Connection) -> IndexReport:
    report = IndexReport()
    conn.execute(text("delete from chunk"))
    conn.commit()
    index_rule_versions(conn, report)
    ids = conn.execute(
        text(
            "select d.id from source_document d where d.raw_text is not null "
            f"  and length(d.raw_text) > 200 and {_LATEST} and {_NOT_LISTING} "
            " order by d.fetched_at desc limit 200"
        )
    ).scalars().all()
    cache: dict[str, set[str]] = {}
    for doc_id in ids:
        try:
            index_document(conn, str(doc_id), report, cache)
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            report.errors.append(f"{doc_id}: {str(exc)[:140]}")
    return report
