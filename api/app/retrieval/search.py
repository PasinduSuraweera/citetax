"""Hybrid retrieval over published chunks (spec section 4.1 node 7).

For explanation prose only. Never for numbers: computation reads the rules
table, and retrieval must not be able to influence a figure.

Hybrid means Postgres full text (BM25 like ranking via ts_rank_cd) fused with
dense cosine similarity by reciprocal rank fusion, then the top N returned.
The reranker in the spec is a cross encoder that needs model weights; on this
build the fusion score stands in for it, and the cap on candidates is enforced
in code rather than by convention.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.retrieval import embeddings

logger = logging.getLogger(__name__)

TOP_K = 6           # passages handed to the model
CANDIDATES = 20     # per retriever, before fusion (spec: reranker sees 20)


@dataclass
class Passage:
    chunk_id: str
    text: str
    source_document_id: str | None
    rule_key: str | None
    title: str | None
    url: str | None
    score: float
    matched_by: str   # "fts" | "dense" | "both"
    # The rule's plain name, for display. The model is still shown `title`
    # or the key, so what it cites is unchanged.
    rule_title: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "chunk_id": self.chunk_id,
            "text": self.text,
            "source_document_id": self.source_document_id,
            "rule_key": self.rule_key,
            "title": self.title,
            "url": self.url,
            "score": round(self.score, 4),
            "matched_by": self.matched_by,
            "rule_title": self.rule_title,
        }


_FTS = text(
    """
    select c.id, c.text, c.source_document_id, c.rule_key, d.title, d.url,
           r.title as rule_title,
           ts_rank_cd(c.tsv, plainto_tsquery('english', :q)) as score
      from chunk c
      left join source_document d on d.id = c.source_document_id
      left join rule r on r.rule_key = c.rule_key
     where c.status = 'published'
       and c.tsv @@ plainto_tsquery('english', :q)
       and (:keys_empty or c.rule_key = any(:keys) or c.rule_key is null)
     order by score desc
     limit :n
    """
)

_DENSE = text(
    """
    select c.id, c.text, c.source_document_id, c.rule_key, d.title, d.url,
           r.title as rule_title,
           1 - (c.embedding <=> cast(:v as vector)) as score
      from chunk c
      left join source_document d on d.id = c.source_document_id
      left join rule r on r.rule_key = c.rule_key
     where c.status = 'published'
       and c.embedding is not null
       and (:keys_empty or c.rule_key = any(:keys) or c.rule_key is null)
     order by c.embedding <=> cast(:v as vector)
     limit :n
    """
)


def search(
    conn: Connection,
    query: str,
    rule_keys: list[str] | None = None,
    top_k: int = TOP_K,
) -> tuple[list[Passage], dict[str, Any]]:
    """Returns (passages, meta). Empty list when nothing is indexed."""
    keys = list(rule_keys or [])
    params = {"q": query, "keys": keys or [""], "keys_empty": not keys, "n": CANDIDATES}
    meta: dict[str, Any] = {"fts": 0, "dense": 0, "fused": 0, "dense_enabled": False}

    fts_rows = conn.execute(_FTS, params).mappings().all()
    meta["fts"] = len(fts_rows)

    dense_rows: list[Any] = []
    if embeddings.dense_enabled():
        meta["dense_enabled"] = True
        try:
            vec = embeddings.get_provider().embed_query(query)
            dense_rows = conn.execute(
                _DENSE, {**params, "v": "[" + ",".join(f"{x:.6f}" for x in vec) + "]"}
            ).mappings().all()
            meta["dense"] = len(dense_rows)
        except Exception as exc:  # noqa: BLE001 — dense is optional, fts still answers
            meta["dense_error"] = str(exc)[:160]
            logger.warning("dense retrieval failed: %s", exc)

    # Reciprocal rank fusion. k=60 is the conventional constant.
    fused: dict[str, dict[str, Any]] = {}

    def add(rows, label: str) -> None:
        for rank, r in enumerate(rows, start=1):
            cid = str(r["id"])
            entry = fused.setdefault(
                cid,
                {"row": r, "score": 0.0, "by": set()},
            )
            entry["score"] += 1.0 / (60 + rank)
            entry["by"].add(label)

    add(fts_rows, "fts")
    add(dense_rows, "dense")

    ordered = sorted(fused.values(), key=lambda e: e["score"], reverse=True)[:top_k]
    meta["fused"] = len(ordered)

    out = []
    for e in ordered:
        r = e["row"]
        out.append(
            Passage(
                chunk_id=str(r["id"]),
                text=r["text"],
                source_document_id=str(r["source_document_id"]) if r["source_document_id"] else None,
                rule_key=r["rule_key"],
                title=r["title"],
                url=r["url"],
                score=e["score"],
                matched_by="both" if len(e["by"]) == 2 else next(iter(e["by"])),
                rule_title=r["rule_title"],
            )
        )
    return out, meta
