"""Retrieval evaluation: how well does search find the right passages?

A labelled set of questions says which documents (by URL fragment) or rules
(by rule key) answer each one. Every question is run through each retriever
(full text only, dense only, and the hybrid the app uses) and scored with the
standard ranking metrics: Hit@k, Precision@k, Recall@k, MRR and nDCG@k.

The metric functions are pure and tested on their own. Relevance is binary and
counted once per label, so two chunks of one document do not both score.
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.retrieval import embeddings
from app.retrieval.search import MODES, Passage, search

EVAL_SET_PATH = Path(__file__).with_name("eval_set.json")
K_VALUES = (1, 3, 6)


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------

def load_eval_set(path: Path = EVAL_SET_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def matches(passage: Passage, matcher: dict[str, str]) -> bool:
    """A matcher names one relevant thing: a rule, or a document by URL fragment."""
    if "rule_key" in matcher:
        return passage.rule_key == matcher["rule_key"]
    if "url_contains" in matcher:
        return matcher["url_contains"].lower() in (passage.url or "").lower()
    return False


def describe(matcher: dict[str, str]) -> str:
    return matcher.get("rule_key") or matcher.get("url_contains") or "?"


def gains(passages: list[Passage], relevant: list[dict[str, str]]) -> list[int]:
    """1 for each passage that is the first to satisfy a label, else 0.
    Two passages for one label do not both count as finding it."""
    remaining = list(relevant)
    out: list[int] = []
    for p in passages:
        hit = next((m for m in remaining if matches(p, m)), None)
        if hit is not None:
            remaining.remove(hit)
            out.append(1)
        else:
            out.append(0)
    return out


# ---------------------------------------------------------------------------
# Metrics. All take the ranked gain list (1 = relevant, in rank order).
# ---------------------------------------------------------------------------

def hit_at(g: list[int], k: int) -> float:
    return 1.0 if any(g[:k]) else 0.0


def precision_at(g: list[int], k: int) -> float:
    return sum(g[:k]) / k


def recall_at(g: list[int], k: int, n_relevant: int) -> float:
    return sum(g[:k]) / n_relevant if n_relevant else 0.0


def reciprocal_rank(g: list[int]) -> float:
    for i, v in enumerate(g, start=1):
        if v:
            return 1.0 / i
    return 0.0


def ndcg_at(g: list[int], k: int, n_relevant: int) -> float:
    dcg = sum(v / math.log2(i + 1) for i, v in enumerate(g[:k], start=1))
    ideal = sum(1 / math.log2(i + 1) for i in range(1, min(n_relevant, k) + 1))
    return dcg / ideal if ideal else 0.0


def score(g: list[int], n_relevant: int, ks: Iterable[int] = K_VALUES) -> dict[str, float]:
    ks = tuple(ks)
    top = max(ks)
    out: dict[str, float] = {"mrr": reciprocal_rank(g)}
    for k in ks:
        out[f"hit@{k}"] = hit_at(g, k)
    out[f"precision@{top}"] = precision_at(g, top)
    out[f"recall@{top}"] = recall_at(g, top, n_relevant)
    out[f"ndcg@{top}"] = ndcg_at(g, top, n_relevant)
    return out


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


# ---------------------------------------------------------------------------
# Running it
# ---------------------------------------------------------------------------

@dataclass
class _Run:
    passages: list[Passage]
    ms: int
    error: str | None = None


def _retrieve(conn: Connection, question: str, mode: str, top: int, vec: list[float] | None) -> _Run:
    t0 = time.perf_counter()
    try:
        passages, meta = search(conn, question, top_k=top, mode=mode, query_vec=vec)
        error = meta.get("dense_error")
    except Exception as exc:  # noqa: BLE001 — one bad question must not sink the run
        conn.rollback()
        passages, error = [], str(exc)[:160]
    return _Run(passages, int((time.perf_counter() - t0) * 1000), error)


def _corpus_stats(conn: Connection) -> dict[str, int]:
    row = conn.execute(
        text("select count(*) as n, count(embedding) as e from chunk where status = 'published'")
    ).mappings().one()
    return {"chunks": int(row["n"]), "embedded": int(row["e"])}


def _coverage(conn: Connection, matcher: dict[str, str]) -> dict[str, Any]:
    """How many chunks a label points at, and how many of those have a vector.
    A label with chunks but no vectors cannot be found by dense search."""
    if "rule_key" in matcher:
        row = conn.execute(
            text("select count(*) as n, count(embedding) as e from chunk "
                 "where status = 'published' and rule_key = :k"),
            {"k": matcher["rule_key"]},
        ).mappings().one()
    else:
        row = conn.execute(
            text("select count(*) as n, count(c.embedding) as e from chunk c "
                 "join source_document d on d.id = c.source_document_id "
                 "where c.status = 'published' and lower(d.url) like :k"),
            {"k": f"%{matcher['url_contains'].lower()}%"},
        ).mappings().one()
    return {"label": describe(matcher), "chunks": int(row["n"]), "embedded": int(row["e"])}


def run(
    conn: Connection,
    eval_set: dict[str, Any] | None = None,
    modes: Iterable[str] = MODES,
) -> dict[str, Any]:
    """Runs every question through every mode. Returns aggregates, a per-category
    breakdown and the ranked results for each question."""
    eval_set = eval_set or load_eval_set()
    modes = [m for m in modes if m in MODES]
    top = max(K_VALUES)
    dense_on = embeddings.dense_enabled()
    if not dense_on:
        modes = [m for m in modes if m == "fts"]

    per_mode: dict[str, list[dict[str, Any]]] = {m: [] for m in modes}
    cases_out: list[dict[str, Any]] = []

    for case in eval_set["cases"]:
        relevant = case["relevant"]
        # Embed once and share it, so a run costs one embedding per question.
        vec: list[float] | None = None
        if dense_on and any(m != "fts" for m in modes):
            try:
                vec = embeddings.get_provider().embed_query(case["question"])
            except Exception:  # noqa: BLE001 — falls back to embedding inside search
                vec = None

        row: dict[str, Any] = {
            "id": case["id"],
            "question": case["question"],
            "category": case["category"],
            "relevant": [describe(m) for m in relevant],
            "coverage": [_coverage(conn, m) for m in relevant],
            "modes": {},
        }
        for mode in modes:
            r = _retrieve(conn, case["question"], mode, top, vec)
            g = gains(r.passages, relevant)
            g += [0] * (top - len(g))
            metrics = score(g, len(relevant))
            rank = next((i for i, v in enumerate(g, start=1) if v), None)
            row["modes"][mode] = {
                "metrics": metrics,
                "first_relevant_rank": rank,
                "latency_ms": r.ms,
                "error": r.error,
                "retrieved": [
                    {
                        "title": p.title or p.rule_title or p.rule_key,
                        "url": p.url,
                        "rule_key": p.rule_key,
                        "relevant": bool(g[i]),
                        "score": round(p.score, 4),
                        "matched_by": p.matched_by,
                    }
                    for i, p in enumerate(r.passages)
                ],
            }
            per_mode[mode].append({"category": case["category"], "ms": r.ms, **metrics})
        cases_out.append(row)

    metric_names = list(next(iter(next(iter(per_mode.values()), [{}]) or [{}]), {}).keys())
    metric_names = [n for n in metric_names if n not in ("category", "ms")]

    def aggregate(rows: list[dict[str, Any]]) -> dict[str, Any]:
        out = {n: round(_mean([r[n] for r in rows]), 4) for n in metric_names}
        out["avg_latency_ms"] = round(_mean([float(r["ms"]) for r in rows]), 1)
        out["questions"] = len(rows)
        return out

    summary: dict[str, Any] = {}
    for mode, rows in per_mode.items():
        categories = sorted({r["category"] for r in rows})
        summary[mode] = {
            "aggregate": aggregate(rows),
            "by_category": {c: aggregate([r for r in rows if r["category"] == c]) for c in categories},
        }

    return {
        "ran_at": datetime.now(timezone.utc).isoformat(),
        "eval_set_version": eval_set.get("version"),
        "eval_set_note": eval_set.get("note"),
        "k_values": list(K_VALUES),
        "dense_enabled": dense_on,
        "corpus": _corpus_stats(conn),
        "questions": len(eval_set["cases"]),
        "summary": summary,
        "cases": cases_out,
    }
