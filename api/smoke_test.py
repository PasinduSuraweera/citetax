"""End to end smoke test against the live stack: real database, real model.

Exercises every path the planner can take, and the guarantees each one keeps.
Run after preflight passes:

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
    print(f"[{PASS if condition else FAIL}] {name}" + (f"  ({detail})" if detail else ""))
    if not condition:
        _failures += 1


def trace_line(r) -> str:
    return " > ".join(f"{t.node}[{t.status}]" for t in r.trace)


def main() -> int:
    settings = get_settings()
    print("=" * 72)
    print("  Citetax smoke test: planner, every intent, live model")
    print("=" * 72)

    with db_conn() as conn:
        snap = current_snapshot(conn)
    check("current snapshot exists", snap is not None)
    if snap is None:
        print("\n  Run: .venv\\Scripts\\python.exe seed\\rules_seed.py")
        return 1

    # ---------------------------------------------------------------- compute
    print("\n--- compute intent ---")
    with db_conn() as conn:
        r = run_answer_graph(
            conn, "What do I owe for 2026/2027 on a salary of LKR 250,000 a month, with EPF deducted?"
        )
    print(f"     {trace_line(r)}")
    print(f"     route via {r.route_source}, {r.latency_ms} ms, {r.llm_budget.total_tokens} tokens")
    check("intent is compute", r.intent == "compute", r.intent)
    check("routed by the model", r.route_source == "llm", r.route_source)
    check("answer produced", r.kind == "answer", r.kind)
    check("year parsed", r.ya == "2026/2027", str(r.ya))
    check("monthly salary annualised", r.facts.employment_income == Decimal("3000000"),
          str(r.facts.employment_income))
    check("EPF stated without amount stays None", r.facts.epf_employee is None)
    check("balance is 57,600", r.computation and r.computation.balance_payable == Decimal("57600.00"))
    check("plan recorded", r.plan == ["Intake", "Route", "Resolve", "Compute", "Comply", "Retrieve", "Explain", "Verify"])
    check("prose released and verified", r.prose is not None and r.badge.value == "all_cited",
          r.verify_result.note if r.verify_result else "")
    if r.prose:
        print(f"     prose: {r.prose[:220]}...")

    # ---------------------------------------------------------------- deadline
    print("\n--- deadline intent (no computation) ---")
    with db_conn() as conn:
        r = run_answer_graph(conn, "When is my return due for 2025/2026?")
    print(f"     {trace_line(r)}")
    check("intent is deadline", r.intent == "deadline", r.intent)
    check("compute node did not run", not any(t.node == "Compute" for t in r.trace))
    check("no ledger", r.computation is None)
    check("deadline resolved", r.compliance is not None and r.compliance.return_due == "2026-11-30",
          str(r.compliance.return_due if r.compliance else None))
    check("prose released", r.prose is not None and r.badge.value == "all_cited",
          r.verify_result.note if r.verify_result else "")
    if r.prose:
        print(f"     prose: {r.prose[:200]}...")

    # ---------------------------------------------------------------- rule lookup
    print("\n--- rule_lookup intent ---")
    with db_conn() as conn:
        r = run_answer_graph(conn, "What is the personal relief for 2026/2027?")
    print(f"     {trace_line(r)}")
    check("intent is rule_lookup", r.intent == "rule_lookup", r.intent)
    check("relief rule resolved", any(rv.rule_key == "relief.personal" for rv in r.lookup))
    check("prose released", r.prose is not None and r.badge.value == "all_cited",
          r.verify_result.note if r.verify_result else "")
    if r.prose:
        print(f"     prose: {r.prose[:200]}...")

    # ---------------------------------------------------------------- compare
    print("\n--- compare intent ---")
    with db_conn() as conn:
        r = run_answer_graph(conn, "What changed between 2025/2026 and 2026/2027?")
    print(f"     {trace_line(r)}")
    check("intent is compare", r.intent == "compare", r.intent)
    check("diff computed", r.compare is not None and "changes" in r.compare)
    if r.compare:
        print(f"     {r.compare['changed_count']} of {len(r.compare['changes'])} rules differ")
    check("prose released", r.prose is not None and r.badge.value == "all_cited",
          r.verify_result.note if r.verify_result else "")
    if r.prose:
        print(f"     prose: {r.prose[:200]}...")

    # ---------------------------------------------------------------- obligation
    print("\n--- obligation intent ---")
    with db_conn() as conn:
        r = run_answer_graph(conn, "Do I need to file a return if I earn 1,500,000 a year in 2026/2027?")
    print(f"     {trace_line(r)}")
    check("intent is obligation", r.intent == "obligation", r.intent)
    check("compliance says no filing needed", r.compliance is not None and r.compliance.must_file is False)
    check("prose released", r.prose is not None and r.badge.value == "all_cited",
          r.verify_result.note if r.verify_result else "")

    # ---------------------------------------------------------------- general
    print("\n--- general intent ---")
    with db_conn() as conn:
        r = run_answer_graph(conn, "How does APIT work for a salaried employee?", ya_override="2026/2027")
    print(f"     {trace_line(r)}")
    check("intent is general or rule_lookup", r.intent in ("general", "rule_lookup"), r.intent)
    check("answered", r.kind == "answer", r.kind)
    check("prose released", r.prose is not None, r.verify_result.note if r.verify_result else "")
    if r.prose:
        print(f"     prose: {r.prose[:200]}...")

    # ---------------------------------------------------------------- guardrails
    print("\n--- guardrails ---")
    with db_conn() as conn:
        r = run_answer_graph(conn, "How do I register for VAT?")
        check("VAT refused", r.kind == "refusal", r.kind)
        check("refusal carries reason and pointer", bool(r.refusal_reason) and bool(r.refusal_pointer))

        r = run_answer_graph(conn, "What do I owe for 2019/2020 on 3,000,000?")
        check("unsupported year refused", r.kind == "refusal" and r.refusal_category == "unsupported-year",
              f"{r.kind}/{r.refusal_category}")

        r = run_answer_graph(conn, "How can I reduce my tax legally?")
        check("advisory refused", r.kind == "refusal", r.kind)

        r = run_answer_graph(conn, "How much tax do I owe?")
        check("missing facts clarify", r.kind == "clarify", r.kind)
        check("one natural question", bool(r.clarify_question) and r.clarify_question.count("?") == 1,
              r.clarify_question or "")
        print(f"     asks: {r.clarify_question}")

        r = run_answer_graph(conn, "I earn 4 lakhs a month, what is my tax for this year?")
        check("'this year' resolves to a supported year", r.ya in settings.supported_yas, str(r.ya))
        check("lakhs understood", r.facts and r.facts.employment_income == Decimal("4800000"),
              str(r.facts.employment_income if r.facts else None))

    # ---------------------------------------------------------------- privacy
    print("\n--- privacy ---")
    with db_conn() as conn:
        r = run_answer_graph(
            conn,
            "I am Nimal Perera, NIC 912345678V, phone 0771234567. For 2026/2027 my salary is LKR 3,000,000.",
        )
    intake = next((t for t in r.trace if t.node == "Intake"), None)
    check("identifiers redacted before routing", bool(intake and "identifier" in (intake.detail or "")),
          intake.detail if intake else "")
    check("no identifier in what the model saw", "912345678" not in r.redacted_question
          and "0771234567" not in r.redacted_question and "Nimal" not in r.redacted_question)
    check("salary survived", r.computation is not None
          and r.computation.steps[0].value == Decimal("3000000.00"))

    # ---------------------------------------------------------------- compute engine
    print("\n--- compute engine (pure Python) ---")
    with db_conn() as conn:
        rules = resolve_many(conn, REQUIRED_RULE_KEYS + ["deadline.return_filing"], "2026/2027", str(snap["id"]))
    c = compute(TaxFacts(ya="2026/2027", employment_income=Decimal("3000000")), rules)
    check("gross tax 57,600", c.gross_tax == Decimal("57600.00"))
    check("8 steps, all cited", len(c.steps) == 8 and all(s.rule_version_id for s in c.steps))

    print("\n" + "=" * 72)
    if _failures:
        print(f"  {_failures} check(s) FAILED")
        return 1
    print("  All checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
