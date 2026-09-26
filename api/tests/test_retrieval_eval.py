"""Retrieval evaluation metrics, checked against hand-worked ranked lists."""

from __future__ import annotations

import math

import pytest

from app.retrieval.evaluation import (
    gains, hit_at, load_eval_set, matches, ndcg_at, precision_at, recall_at,
    reciprocal_rank, score,
)
from app.retrieval.search import Passage


def _p(url=None, rule_key=None) -> Passage:
    return Passage(
        chunk_id="c", text="t", source_document_id=None, rule_key=rule_key,
        title=None, url=url, score=0.0, matched_by="fts",
    )


def test_hit_at():
    assert hit_at([0, 0, 1], 3) == 1.0
    assert hit_at([0, 0, 1], 2) == 0.0
    assert hit_at([0, 0, 0], 3) == 0.0


def test_reciprocal_rank():
    assert reciprocal_rank([1, 0, 0]) == 1.0
    assert reciprocal_rank([0, 0, 1]) == pytest.approx(1 / 3)
    assert reciprocal_rank([0, 0, 0]) == 0.0


def test_precision_and_recall():
    g = [1, 0, 1, 0, 0, 0]
    assert precision_at(g, 6) == pytest.approx(2 / 6)
    assert precision_at(g, 3) == pytest.approx(2 / 3)
    assert recall_at(g, 6, 4) == pytest.approx(2 / 4)
    assert recall_at(g, 1, 4) == pytest.approx(1 / 4)
    assert recall_at(g, 6, 0) == 0.0


def test_ndcg_perfect_and_worst_placement():
    # One relevant item: rank 1 is perfect, rank 3 is discounted by log2(4).
    assert ndcg_at([1, 0, 0], 3, 1) == pytest.approx(1.0)
    assert ndcg_at([0, 0, 1], 3, 1) == pytest.approx((1 / math.log2(4)) / 1.0)
    assert ndcg_at([0, 0, 0], 3, 1) == 0.0


def test_ndcg_ideal_is_capped_by_k():
    # Five relevant exist but only three slots: three in a row is a perfect score.
    assert ndcg_at([1, 1, 1], 3, 5) == pytest.approx(1.0)


def test_matches_by_url_and_rule():
    assert matches(_p(url="https://x.lk/Article/EK"), {"url_contains": "/article/ek"})
    assert not matches(_p(url="https://x.lk/article/san"), {"url_contains": "/article/ek"})
    assert matches(_p(rule_key="relief.personal"), {"rule_key": "relief.personal"})
    assert not matches(_p(url=None), {"url_contains": "anything"})
    assert not matches(_p(rule_key="a"), {"bogus": "a"})


def test_a_label_is_found_once_even_if_two_passages_match():
    rel = [{"url_contains": "/ek"}, {"url_contains": "/san"}]
    got = gains([_p(url="/ek/1"), _p(url="/ek/2"), _p(url="/san")], rel)
    assert got == [1, 0, 1]


def test_score_keys_and_values():
    s = score([0, 1, 0, 0, 0, 0], 1)
    assert s["mrr"] == 0.5
    assert s["hit@1"] == 0.0 and s["hit@3"] == 1.0 and s["hit@6"] == 1.0
    assert s["precision@6"] == pytest.approx(1 / 6)
    assert s["recall@6"] == 1.0


def test_eval_set_is_well_formed():
    data = load_eval_set()
    ids = [c["id"] for c in data["cases"]]
    assert len(ids) == len(set(ids)) >= 20
    for c in data["cases"]:
        assert c["question"].strip() and c["category"]
        assert c["relevant"], f"{c['id']} has no labels"
        for m in c["relevant"]:
            assert set(m) in ({"rule_key"}, {"url_contains"})
