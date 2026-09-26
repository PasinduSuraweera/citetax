"""Runs the retrieval evaluation and prints the comparison.

    python eval_retrieval.py            # all three retrievers
    python eval_retrieval.py --json out.json
    python eval_retrieval.py --misses   # also list the questions each one got wrong
"""

from __future__ import annotations

import argparse
import json
import sys

from app.db.session import db_conn
from app.retrieval import evaluation

COLUMNS = ["hit@1", "hit@3", "hit@6", "mrr", "precision@6", "recall@6", "ndcg@6"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="write the full result to this file")
    ap.add_argument("--misses", action="store_true", help="list questions with no relevant hit in the top 6")
    args = ap.parse_args()

    with db_conn() as conn:
        result = evaluation.run(conn)

    corpus = result["corpus"]
    print(
        f"\n{result['questions']} questions, eval set {result['eval_set_version']}, "
        f"{corpus['chunks']} chunks ({corpus['embedded']} embedded), dense "
        f"{'on' if result['dense_enabled'] else 'OFF'}\n"
    )
    print(f"{'retriever':<10}" + "".join(f"{c:>13}" for c in COLUMNS) + f"{'ms/query':>10}")
    for mode, block in result["summary"].items():
        a = block["aggregate"]
        print(f"{mode:<10}" + "".join(f"{a[c]:>13.3f}" for c in COLUMNS) + f"{a['avg_latency_ms']:>10.0f}")

    if args.misses:
        for mode in result["summary"]:
            print(f"\nMisses for {mode}:")
            for c in result["cases"]:
                m = c["modes"][mode]
                if m["first_relevant_rank"] is None:
                    print(f"  {c['id']} [{c['category']}] {c['question']}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        print(f"\nWrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
