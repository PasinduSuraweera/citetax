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
import re
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.retrieval import embeddings

logger = logging.getLogger(__name__)

TOP_K = 6           # passages handed to the model
CANDIDATES = 20     # per retriever, before fusion (spec: reranker sees 20)
# Dense similarity always returns its top N, however weak, and on this corpus
# scores bunch between about 0.63 and 0.74. A fixed floor would cut good
# matches for some questions and keep noise for others, so a dense match must
# instead sit within this margin of the question's best dense match.
DENSE_MARGIN = 0.04
# Index pages ("... Read More ... Read More") match nearly every question and
# say nothing on their own.
MODES = ("hybrid", "fts", "dense")

_LISTING = re.compile(r"\bRead More\b", re.I)


def _readable(text_: str | None) -> bool:
    """False for index pages and for PDF text that came out letter-spaced
    ("N O T I C E T O T A X P A Y E R S"), which no reader can use."""
    t = text_ or ""
    if len(_LISTING.findall(t)) >= 2:
        return False
    words = t.split()
    if len(words) >= 20 and sum(len(w) == 1 for w in words) / len(words) > 0.5:
        return False
    return True


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


_SIM = text(
    """
    select c.id, 1 - (c.embedding <=> cast(:v as vector)) as score
      from chunk c
     where c.id = any(cast(:ids as uuid[])) and c.embedding is not null
    """
)


def search(
    conn: Connection,
    query: str,
    rule_keys: list[str] | None = None,
    top_k: int = TOP_K,
    mode: str = "hybrid",
    query_vec: list[float] | None = None,
) -> tuple[list[Passage], dict[str, Any]]:
    """Returns (passages, meta). Empty list when nothing is indexed.

    `mode` is "hybrid" (the default the app uses), "fts" or "dense". The other
    two exist so the evaluation can measure each retriever on its own.
    `query_vec` lets a caller that already embedded the question reuse it.
    """
    if mode not in MODES:
        raise ValueError(f"unknown retrieval mode {mode!r}")
    keys = list(rule_keys or [])
    params = {"q": query, "keys": keys or [""], "keys_empty": not keys, "n": CANDIDATES}
    meta: dict[str, Any] = {"fts": 0, "dense": 0, "fused": 0, "dense_enabled": False}

    fts_rows = conn.execute(_FTS, params).mappings().all() if mode != "dense" else []
    meta["fts"] = len(fts_rows)

    dense_rows: list[Any] = []
    sim: dict[str, float] = {}
    if mode != "fts" and embeddings.dense_enabled():
        meta["dense_enabled"] = True
        try:
            vec = query_vec or embeddings.get_provider().embed_query(query)
            v = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
            dense_rows = conn.execute(_DENSE, {**params, "v": v}).mappings().all()
            meta["dense"] = len(dense_rows)
            sim = {str(r["id"]): float(r["score"]) for r in dense_rows}
            # Keyword hits get the same relevance test as dense ones, so a
            # word shared with a page's boilerplate is not a way in.
            missing = [str(r["id"]) for r in fts_rows if str(r["id"]) not in sim]
            if missing:
                for r in conn.execute(_SIM, {"ids": missing, "v": v}).mappings():
                    sim[str(r["id"])] = float(r["score"])
        except Exception as exc:  # noqa: BLE001 — dense is optional, fts still answers
            meta["dense_error"] = str(exc)[:160]
            logger.warning("dense retrieval failed: %s", exc)

    def relevant(r) -> bool:
        s = sim.get(str(r["id"]))
        # No similarity (dense off, or the chunk has no embedding): only the
        # keyword match speaks for it.
        return s is None or s >= floor

    floor = (max(sim.values()) - DENSE_MARGIN) if sim else 0.0
    fts_rows = [r for r in fts_rows if relevant(r) and _readable(r["text"])]
    dense_rows = [r for r in dense_rows if relevant(r) and _readable(r["text"])]
    meta["kept"] = len({str(r["id"]) for r in [*fts_rows, *dense_rows]})

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

    # One passage per document, and per rule: three chunks of one article are
    # one source, and the next best document gets the slot instead.
    ordered = []
    seen: set[str] = set()
    for e in sorted(fused.values(), key=lambda e: e["score"], reverse=True):
        r = e["row"]
        # By URL first: two revisions of one page are one source.
        group = (
            f"url:{r['url']}" if r["url"]
            else f"doc:{r['source_document_id']}" if r["source_document_id"]
            else f"rule:{r['rule_key']}" if r["rule_key"]
            else f"chunk:{r['id']}"
        )
        if group in seen:
            continue
        seen.add(group)
        ordered.append(e)
        if len(ordered) == top_k:
            break
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
