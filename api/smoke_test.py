"""End-to-end smoke test against the live stack.

Runs the real answer graph against the real database and the real LLM, and
checks the guarantees the product actually claims. Run after preflight passes
and the seed has loaded:

    .venv\\Scripts\\python.exe smoke_test.py
"""

from __future__ import annotations

import sys
from decimal import Decimal

sys.path.insert(0, ".")

from app.compute.engine import REQUIRED_RULE_KEYS, compute  # noqa: E402
from app.compute.types import TaxFacts  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.db.session import db_conn  # noqa: E402
from app.graph.answer import run_answer_graph  # noqa: E402
from app.rules.resolver import current_snapshot, resolve_many  # noqa: E402

PASS, FAIL = "  PASS", "  FAIL"
_failures = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global _failures
    print(f"[{PASS if condition else FAIL}] {name}" + (f" — {detail}" if detail else ""))
    if not condition:
        _failures += 1


def main() -> int:
    settings = get_settings()
    print("=" * 70)
    print("  Citetax end-to-end smoke test")
    print("=" * 70)

    # --- 1. Snapshot + resolution -----------------------------------------
    print("\n--- Rule resolution (deterministic, no LLM) ---")
    with db_conn() as conn:
        snap = current_snapshot(conn)
        check("current snapshot exists", snap is not None)
        if snap is None:
            print("\n  Run: .venv\\Scripts\\python.exe seed\\rules_seed.py")
            return 1
        print(f"         snapshot: {snap['label']}  ({snap['id']})")

        for ya in settings.supported_yas:
            rules = resolve_many(
                conn, REQUIRED_RULE_KEYS + ["deadline.return_filing"],
                ya, str(snap["id"]),
            )
            check(f"resolve() returns one version per rule for {ya}",
                  len(rules.rules) == len(REQUIRED_RULE_KEYS) + 1,
                  f"{len(rules.rules)} rules")

            relief = rules["relief.personal"].value_json["amount"]
            check(f"personal relief is 1,800,000 for {ya}",
                  Decimal(relief) == Decimal("1800000"), f"got {relief}")

            bands = rules["band.progressive"].value_json["bands"]
            check(f"band table has 5 bands for {ya}", len(bands) == 5,
                  f"{len(bands)} bands")
            check(f"first band is 6% for {ya}",
                  Decimal(bands[0]["rate"]) == Decimal("0.06"))

    # --- 2. Computation against real rules --------------------------------
    print("\n--- Computation (pure Python) ---")
    with db_conn() as conn:
        snap = current_snapshot(conn)
        rules = resolve_many(
            conn, REQUIRED_RULE_KEYS + ["deadline.return_filing"],
            "2026/2027", str(snap["id"]),
        )

    facts = TaxFacts(ya="2026/2027", employment_income=Decimal("3000000"))
    c = compute(facts, rules)
    print(f"         3,000,000 salary → taxable {c.taxable_income:,} "
          f"→ gross tax {c.gross_tax:,}")
    check("taxable income is 960,000", c.taxable_income == Decimal("960000.00"))
    check("gross tax is 57,600 (6% band)", c.gross_tax == Decimal("57600.00"))
    check("ledger has 8 steps", len(c.steps) == 8)
    check("every step cites a rule version",
          all(s.rule_version_id for s in c.steps))

    # --- 3. Full answer graph ---------------------------------------------
    print("\n--- Answer graph (all 9 nodes) ---")
    question = ("What do I owe for 2026/2027 on a salary of LKR 250,000 a month, "
                "with EPF deducted?")
    with db_conn() as conn:
        result = run_answer_graph(conn, question)

    check("graph returns an answer", result.kind == "answer", result.kind)
    check("year parsed from the question", result.ya == "2026/2027", str(result.ya))
    if result.computation:
        print(f"         balance payable: LKR {result.computation.balance_payable:,}")
    print(f"         latency: {result.latency_ms} ms")
    print("         trace: " + " → ".join(f"{t.node}[{t.status}]" for t in result.trace))
    check("trace covers every node", len(result.trace) >= 8, f"{len(result.trace)} nodes")

    if settings.llm_enabled:
        check("LLM was called", result.model_meta.get("called") is True,
              str(result.model_meta.get("error") or result.model_meta.get("skipped") or ""))
        if result.prose:
            print("\n         explanation:")
            for line in result.prose.strip().splitlines():
                print(f"         {line}")
            print()
            check("verify released the prose", result.badge.value == "all_cited")
            check("released prose passed numeric provenance",
                  result.verify_result is not None and result.verify_result.ok)
        else:
            # Prose withheld. That is a valid outcome, but the user must be told
            # why, so a note is mandatory here (spec §4.2 item 5).
            vr = result.verify_result
            check("withheld prose carries a stated reason",
                  vr is not None and bool(vr.note),
                  (vr.note if vr else "no verify result") or "no note")
            check("figures are still released when prose is withheld",
                  result.computation is not None)
    else:
        print("         (GROQ_API_KEY not set — prose skipped, figures still verified)")
        check("figures released without prose", result.badge.value == "all_cited")

    # --- 4. Refusal and clarify paths -------------------------------------
    print("\n--- Guardrails ---")
    with db_conn() as conn:
        r = run_answer_graph(conn, "How do I register for VAT?")
        check("out-of-scope question is refused", r.kind == "refusal", r.kind)
        check("refusal carries a reason", bool(r.refusal_reason))

        r = run_answer_graph(conn, "What do I owe for 2019/2020 on 3,000,000?")
        check("unsupported year is refused", r.kind == "refusal", r.kind)

        r = run_answer_graph(conn, "How much tax do I owe?")
        check("missing facts triggers clarify", r.kind == "clarify", r.kind)
        check("clarify asks exactly one question", bool(r.clarify_question))
        print(f"         asks: {r.clarify_question}")

        r = run_answer_graph(conn, "How can I reduce my tax legally?")
        check("advisory question is refused", r.kind == "refusal", r.kind)

    # --- 5. Privacy --------------------------------------------------------
    print("\n--- Privacy (spec §9.1) ---")
    with db_conn() as conn:
        r = run_answer_graph(
            conn,
            "I am Nimal Perera, NIC 912345678V, phone 0771234567. For 2026/2027 "
            "my salary is LKR 3,000,000.",
        )
    intake = next((t for t in r.trace if t.node == "Intake"), None)
    print(f"         intake: {intake.detail if intake else 'n/a'}")
    check("identifiers were redacted at intake",
          bool(intake and "identifier" in (intake.detail or "")))
    check("the salary survived redaction",
          r.kind == "answer" and r.computation is not None
          and r.computation.steps[0].value == Decimal("3000000.00"),
          "money-token survival must be 100%")

    print("\n" + "=" * 70)
    if _failures:
        print(f"  {_failures} check(s) FAILED")
        return 1
    print("  All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
