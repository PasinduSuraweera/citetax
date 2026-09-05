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
from dataclasses import dataclass, field
from typing import Any

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


def index_document(conn: Connection, doc_id: str, report: IndexReport | None = None) -> IndexReport:
    """Chunk and embed one source document's raw text."""
    report = report or IndexReport()
    provider = embeddings.get_provider()

    row = conn.execute(
        text("select id, raw_text from source_document where id = :id"), {"id": doc_id}
    ).mappings().first()
    if not row or not row["raw_text"]:
        report.skipped += 1
        return report

    conn.execute(text("delete from chunk where source_document_id = :id"), {"id": doc_id})
    pieces = chunk_text(row["raw_text"])
    _write_chunks(conn, doc_id, None, [p.text for p in pieces], provider, report)
    report.documents += 1
    conn.commit()
    return report


def index_unindexed_documents(conn: Connection, limit: int = 20) -> IndexReport:
    """Documents with text that have no chunks yet. Called by the scheduler."""
    report = IndexReport()
    ids = conn.execute(
        text(
            "select d.id from source_document d "
            " where d.raw_text is not null and length(d.raw_text) > 200 "
            "   and not exists (select 1 from chunk c where c.source_document_id = d.id) "
            " order by d.fetched_at desc limit :n"
        ),
        {"n": limit},
    ).scalars().all()
    for doc_id in ids:
        try:
            index_document(conn, str(doc_id), report)
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
            "select id from source_document where raw_text is not null "
            "  and length(raw_text) > 200 order by fetched_at desc limit 200"
        )
    ).scalars().all()
    for doc_id in ids:
        try:
            index_document(conn, str(doc_id), report)
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            report.errors.append(f"{doc_id}: {str(exc)[:140]}")
    return report
