"""The answer graph, planner driven.

The old graph ran the same nine nodes for every question. This one asks the
model what the user wants, then runs only the nodes that intent needs:

  compute      Route → Resolve → Compute → Comply → Retrieve → Explain → Verify
  obligation   Route → Resolve → Compute → Comply → Explain → Verify
  deadline     Route → Resolve(deadline) → Retrieve → Explain → Verify
  compare      Route → Resolve(both years) → Diff → Retrieve → Explain → Verify
  rule_lookup  Route → Resolve(asked rules) → Retrieve → Explain → Verify
  general      Route → Retrieve → Resolve(for citations) → Explain → Verify
  out_of_scope Route → refuse

Two things never change with the path. Numbers come from the rules table and the
compute engine, never from the model. And Verify runs on every word of prose the
model produces, whatever the intent.

The trace records the plan before executing it, so the UI can show the agent's
intention and then fill in what actually happened.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable

from sqlalchemy.engine import Connection

from app.core import years
from app.compute.engine import OPTIONAL_RULE_KEYS, REQUIRED_RULE_KEYS, compute
from app.compute.types import Computation, TaxFacts
from app.conversations.context import ConversationContext
from app.core import llm
from app.core.config import get_settings
from app.compute import savings as savings_mod
from app.compute.savings import Savings
from app.graph import comply, intent as intent_mod
from app.graph.explain import ExplainContext, explain
from app.graph.verify import BadgeState, Evidence, VerifyResult, verify
from app.privacy.redactor import CodedRedactor, truncate_for_llm
from app.retrieval import search as retrieval
from app.retrieval.search import Passage
from app.rules.resolver import (
    AmbiguousRule,
    ResolvedRuleSet,
    RuleVersion,
    UnresolvedRule,
    current_snapshot,
    resolve,
    resolve_many,
)

ALL_KEYS = REQUIRED_RULE_KEYS + ["deadline.return_filing"]

PLANS: dict[str, list[str]] = {
    "compute":     ["Intake", "Route", "Resolve", "Compute", "Comply", "Retrieve", "Explain", "Verify"],
    "obligation":  ["Intake", "Route", "Resolve", "Compute", "Comply", "Explain", "Verify"],
    "deadline":    ["Intake", "Route", "Resolve", "Retrieve", "Explain", "Verify"],
    "compare":     ["Intake", "Route", "Resolve", "Compare", "Retrieve", "Explain", "Verify"],
    "rule_lookup": ["Intake", "Route", "Resolve", "Retrieve", "Explain", "Verify"],
    "general":     ["Intake", "Route", "Retrieve", "Resolve", "Explain", "Verify"],
    "out_of_scope": ["Intake", "Route"],
}


@dataclass
class TraceEntry:
    node: str
    status: str            # ok | refused | skipped | failed | planned
    detail: str | None = None
    ms: int = 0

    def to_json(self) -> dict[str, Any]:
        return {"node": self.node, "status": self.status, "detail": self.detail, "ms": self.ms}


@dataclass
class AnswerResult:
    kind: str                      # answer | refusal | clarify
    intent: str = "compute"
    plan: list[str] = field(default_factory=list)
    route_source: str = "regex"
    ya: str | None = None
    computation: Computation | None = None
    compliance: comply.Compliance | None = None
    rules: ResolvedRuleSet | None = None
    lookup: list[RuleVersion] = field(default_factory=list)
    compare: dict[str, Any] | None = None
    passages: list[Passage] = field(default_factory=list)
    prose: str | None = None
    verify_result: VerifyResult | None = None
    badge: BadgeState = BadgeState.ALL_CITED
    refusal_reason: str | None = None
    refusal_pointer: str | None = None
    refusal_category: str | None = None
    clarify_question: str | None = None
    facts: TaxFacts | None = None
    snapshot: dict[str, Any] | None = None
    trace: list[TraceEntry] = field(default_factory=list)
    latency_ms: int = 0
    llm_budget: llm.LLMBudget = field(default_factory=llm.LLMBudget)
    redacted_question: str = ""
    days_remaining: int | None = None
    savings: Savings | None = None

    @property
    def model_meta(self) -> dict[str, Any]:
        return self.llm_budget.to_json()


_REDACTOR = CodedRedactor(use_ner=True)

_POINTERS = {
    "VAT": "https://www.ird.gov.lk | Value Added Tax",
    "SSCL": "https://www.ird.gov.lk | Social Security Contribution Levy",
    "corporate": "https://www.ird.gov.lk | Corporate Income Tax",
    "employer-filing": "https://www.ird.gov.lk | APIT for employers",
    "representation": "https://www.ird.gov.lk | Appeals",
    "unsupported-year": "https://www.ird.gov.lk | Publications",
}


def run_answer_graph(
    conn: Connection,
    question: str,
    ya_override: str | None = None,
    facts_override: TaxFacts | None = None,
    context: ConversationContext | None = None,
    on_node: Callable[[TraceEntry], None] | None = None,
    on_plan: Callable[[list[str]], None] | None = None,
) -> AnswerResult:
    """Answer one question.

    `context` is the bounded, redacted slice of the conversation the
    question belongs to, built by app.conversations.context. Only Route
    reads it. Resolve, Compute, Explain and Verify see the current turn
    alone, and the rules are always resolved against the current snapshot.

    `on_node`, when given, fires the instant each step actually finishes —
    not a guess, not a timer. The streaming endpoint uses it to push real
    progress to the client as the graph runs; the plain endpoint leaves it
    unset and just gets the trace list at the end, as before. `on_plan` fires
    once, as soon as Route has chosen the plan, so the client knows which
    steps are still to come.
    """
    settings = get_settings()
    started = time.perf_counter()
    result = AnswerResult(kind="answer")
    trace = result.trace
    budget = result.llm_budget

    def mark(node: str, status: str, detail: str | None = None, t0: float | None = None) -> None:
        ms = int((time.perf_counter() - (t0 or started)) * 1000)
        entry = TraceEntry(node=node, status=status, detail=detail, ms=ms)
        trace.append(entry)
        if on_node is not None:
            on_node(entry)

    def finish() -> AnswerResult:
        result.latency_ms = int((time.perf_counter() - started) * 1000)
        return result

    def refuse(reason: str, category: str | None, node: str, t0: float) -> AnswerResult:
        mark(node, "refused", reason, t0)
        result.kind = "refusal"
        result.badge = BadgeState.CANNOT_ANSWER
        result.refusal_reason = reason
        result.refusal_category = category
        result.refusal_pointer = _POINTERS.get(category or "")
        return finish()

    # --- Intake: redact in process, nothing leaves the machine ---------------
    t0 = time.perf_counter()
    redacted = _REDACTOR.redact(question)
    result.redacted_question = truncate_for_llm(redacted.text, settings.max_free_text_to_llm)
    mark(
        "Intake", "ok",
        f"{redacted.total} identifier(s) redacted"
        + ("" if redacted.ner_available else "; NER unavailable"),
        t0,
    )

    # --- Route: one model call decides intent, facts, scope, and the plan ---
    t0 = time.perf_counter()
    routed = intent_mod.route(
        result.redacted_question, question, settings.supported_yas, budget,
        context=context,
    )
    r = routed.routed
    result.intent = r.intent
    result.route_source = routed.source
    result.plan = list(PLANS.get(r.intent, PLANS["general"]))
    if on_plan is not None:
        on_plan(result.plan)

    facts = facts_override if facts_override is not None else routed.facts
    if context is not None and context.ya and not facts.ya:
        # A year the question names wins, then the conversation's, then the
        # sidebar's.
        facts.ya = context.ya  # type: ignore[assignment]
    if ya_override and not facts.ya:
        # The sidebar year applies only when the question did not name one.
        facts.ya = ya_override  # type: ignore[assignment]
    result.facts = facts
    result.ya = facts.ya

    route_detail = f"{r.intent} via {routed.source}"
    if routed.notes:
        route_detail += "; " + "; ".join(routed.notes)

    if not r.in_scope or r.intent == "out_of_scope":
        return refuse(
            r.scope_reason or "This is outside what Citetax covers.",
            r.scope_category, "Route", t0,
        )
    mark("Route", "ok", route_detail, t0)

    # --- Clarify: only compute and obligation need facts ---------------------
    if r.intent in ("compute", "obligation"):
        missing = facts.missing_required()
        if missing:
            result.kind = "clarify"
            result.clarify_question = r.clarify_question or {
                "ya": f"Which year of assessment are you asking about, {years.phrase()}?",
                "income": "What was your total income for the year? A monthly figure is fine.",
            }.get(missing[0], "Could you give me a little more detail?")
            mark("Route", "ok", f"clarify: missing {missing[0]}", t0)
            return finish()
        if routed.untraced and facts_override is None:
            # A conversation follow-up whose figures do not trace to anything
            # the user said. Asking is the safe failure; guessing is not.
            result.kind = "clarify"
            result.clarify_question = routed.untraced_question
            mark("Route", "ok", "clarify: figure not traceable", t0)
            return finish()
    elif not facts.ya:
        # Non-computational intents still need a year to resolve against.
        facts.ya = ya_override or settings.supported_yas[-1]  # type: ignore[assignment]
        result.ya = facts.ya

    # --- Snapshot ------------------------------------------------------------
    snapshot = current_snapshot(conn)
    if snapshot is None:
        return refuse(
            "No corpus snapshot is published, so there is nothing to resolve against.",
            None, "Resolve", time.perf_counter(),
        )
    result.snapshot = {
        "id": str(snapshot["id"]), "label": snapshot["label"],
        "changelog": snapshot.get("changelog"),
    }
    snap_id = str(snapshot["id"])

    # --- Dispatch on intent --------------------------------------------------
    handler = {
        "compute": _run_compute,
        "obligation": _run_compute,
        "deadline": _run_deadline,
        "compare": _run_compare,
        "rule_lookup": _run_lookup,
        "general": _run_general,
    }.get(r.intent, _run_general)

    try:
        handler(conn, result, r, facts, snap_id, mark, budget)
    except UnresolvedRule as exc:
        return refuse(
            f"No rule in force found for {exc.rule_key} in year of assessment "
            f"{exc.ya}. Citetax will not guess a figure.",
            "no_rule", "Resolve", time.perf_counter(),
        )
    except AmbiguousRule as exc:
        return refuse(
            "The corpus contains conflicting rule versions for this year. The "
            "answer is blocked and an administrator has been notified.",
            "integrity", "Resolve", time.perf_counter(),
        )

    return finish()


# ---------------------------------------------------------------------------
# Intent handlers. Each runs its nodes, then hands off to _explain_and_verify.
# ---------------------------------------------------------------------------

def _run_compute(conn, result, r, facts, snap_id, mark, budget) -> None:
    t0 = time.perf_counter()
    rules = resolve_many(conn, ALL_KEYS, facts.ya, snap_id, as_of=facts.as_of, optional=OPTIONAL_RULE_KEYS)
    result.rules = rules
    mark("Resolve", "ok", f"{len(rules.rules)} rules at snapshot {result.snapshot['label']}", t0)

    t0 = time.perf_counter()
    computation = compute(facts, rules)
    result.computation = computation
    mark("Compute", "ok", f"{len(computation.steps)} steps, pure Python", t0)

    t0 = time.perf_counter()
    compliance = comply.assess(computation, rules)
    result.compliance = compliance
    result.days_remaining = comply.days_until(compliance.return_due)
    mark("Comply", "ok", "must file" if compliance.must_file else "no filing obligation", t0)

    if r.intent == "compute":
        result.savings = savings_mod.analyse(facts, rules, computation)
        used_keys = [s.rule_key for s in computation.steps if not s.is_zero]
        _retrieve(conn, result, mark, used_keys)

    _explain_and_verify(result, mark, budget)


def _run_deadline(conn, result, r, facts, snap_id, mark, budget) -> None:
    t0 = time.perf_counter()
    rv = resolve(conn, "deadline.return_filing", facts.ya, snap_id, as_of=facts.as_of)
    rules = ResolvedRuleSet(ya=facts.ya, snapshot_id=snap_id, rules={rv.rule_key: rv})
    result.rules = rules
    result.lookup = [rv]
    due = rv.value_json.get("due")
    result.compliance = comply.Compliance(
        must_file=True, reason="Filing dates for the year of assessment.",
        return_due=due, instalments=list(rv.value_json.get("instalments", [])),
        rule_version_id=rv.id, citation_label=rv.citation_label,
    )
    result.days_remaining = comply.days_until(due)
    mark("Resolve", "ok", f"deadline rule {rv.citation_label}, due {due}", t0)

    _retrieve(conn, result, mark, ["deadline.return_filing"])
    _explain_and_verify(result, mark, budget)


def _run_compare(conn, result, r, facts, snap_id, mark, budget) -> None:
    settings = get_settings()
    from_ya = r.compare_from if r.compare_from in settings.supported_yas else settings.supported_yas[0]
    to_ya = r.compare_to if r.compare_to in settings.supported_yas else settings.supported_yas[-1]
    if from_ya == to_ya:
        from_ya, to_ya = settings.supported_yas[0], settings.supported_yas[-1]

    t0 = time.perf_counter()
    a = resolve_many(conn, ALL_KEYS, from_ya, snap_id)
    b = resolve_many(conn, ALL_KEYS, to_ya, snap_id)
    result.rules = b
    result.ya = to_ya
    mark("Resolve", "ok", f"{len(ALL_KEYS)} rules for each of {from_ya} and {to_ya}", t0)

    t0 = time.perf_counter()
    from sqlalchemy import text as _sql

    titles = {
        row[0]: row[1]
        for row in conn.execute(_sql("select rule_key, title from rule")).all()
    }
    changes = []
    for key in ALL_KEYS:
        ra, rb = a.rules[key], b.rules[key]
        changes.append({
            "rule_key": key,
            "title": titles.get(key, key),
            "changed": ra.value_json != rb.value_json,
            "from": {"value": ra.value_json, "rule_version_id": ra.id,
                     "citation_label": ra.citation_label,
                     "effective_from": ra.effective_from.isoformat()},
            "to": {"value": rb.value_json, "rule_version_id": rb.id,
                   "citation_label": rb.citation_label,
                   "effective_from": rb.effective_from.isoformat()},
        })
    result.compare = {
        "from_ya": from_ya, "to_ya": to_ya,
        "changed_count": sum(1 for c in changes if c["changed"]),
        "changes": changes,
    }
    mark("Compare", "ok", f"{result.compare['changed_count']} of {len(changes)} rules differ", t0)

    changed_keys = [c["rule_key"] for c in changes if c["changed"]] or ALL_KEYS[:3]
    _retrieve(conn, result, mark, changed_keys)
    _explain_and_verify(result, mark, budget)


def _run_lookup(conn, result, r, facts, snap_id, mark, budget) -> None:
    keys = [k for k in r.rule_keys if k in ALL_KEYS] or _guess_keys(result.redacted_question)
    t0 = time.perf_counter()
    rules = resolve_many(conn, keys, facts.ya, snap_id, as_of=facts.as_of)
    result.rules = rules
    result.lookup = list(rules.rules.values())
    mark("Resolve", "ok", ", ".join(keys), t0)

    _retrieve(conn, result, mark, keys)
    _explain_and_verify(result, mark, budget)


def _run_general(conn, result, r, facts, snap_id, mark, budget) -> None:
    keys = [k for k in r.rule_keys if k in ALL_KEYS]
    _retrieve(conn, result, mark, keys or None)

    # Resolve whatever rules the question touches, or everything if it is
    # broad, so the model has reviewer approved law text to ground on and the
    # citations panel has something to show.
    t0 = time.perf_counter()
    resolve_keys = keys or ALL_KEYS
    rules = resolve_many(conn, resolve_keys, facts.ya, snap_id)
    result.rules = rules
    mark("Resolve", "ok", f"{len(rules.rules)} rules for citation", t0)

    _explain_and_verify(result, mark, budget)


# ---------------------------------------------------------------------------
# Shared tail: retrieve, explain, verify
# ---------------------------------------------------------------------------

def _retrieve(conn, result, mark, rule_keys: list[str] | None) -> None:
    t0 = time.perf_counter()
    try:
        passages, meta = retrieval.search(conn, result.redacted_question, rule_keys, ya=result.ya)
        result.passages = passages
        detail = f"{len(passages)} passages"
        if meta.get("dense_enabled"):
            detail += f" (fts {meta['fts']}, dense {meta['dense']})"
        else:
            detail += " (full text only)"
        if not passages:
            detail = "nothing indexed yet; using resolved law text"
        mark("Retrieve", "ok" if passages else "skipped", detail, t0)
    except Exception as exc:  # noqa: BLE001 — retrieval is for prose, never blocking
        conn.rollback()
        mark("Retrieve", "failed", str(exc)[:120], t0)


def _explain_and_verify(result: AnswerResult, mark, budget: llm.LLMBudget) -> None:
    ctx = ExplainContext(
        intent=result.intent, ya=result.ya,
        redacted_question=result.redacted_question,
        rules=result.rules, computation=result.computation,
        compliance=result.compliance, passages=result.passages,
        compare=result.compare, lookup=result.lookup,
        days_remaining=result.days_remaining,
    )
    evidence = Evidence(
        computation=result.computation, rules=result.rules,
        compliance=result.compliance, passages=result.passages,
        extra_rules=result.lookup, compare=result.compare,
        days_remaining=result.days_remaining,
    )

    t0 = time.perf_counter()
    prose, meta = explain(ctx, budget=budget)
    if prose is None:
        mark("Explain", "skipped", meta.get("skipped") or meta.get("error"), t0)
        result.prose = None
        result.badge = BadgeState.ALL_CITED
        result.verify_result = VerifyResult(
            badge=BadgeState.ALL_CITED, ok=True, prose_released=False,
            note="Explanation unavailable. The figures shown are verified.",
        )
        mark("Verify", "ok", "no prose; figures verified by construction", time.perf_counter())
        return
    mark("Explain", "ok", f"{len(prose)} chars, {meta.get('tokens', {}).get('out', 0)} tokens", t0)

    t0 = time.perf_counter()
    vr = verify(prose, evidence, attempt=1)
    if not vr.ok and not vr.pii_classes:
        retry_note = ", ".join(vr.unmatched_numbers)
        prose2, _ = explain(ctx, retry_note=retry_note, budget=budget)
        if prose2 is not None:
            vr2 = verify(prose2, evidence, attempt=2)
            if vr2.ok:
                prose, vr = prose2, vr2
            else:
                vr = vr2

    if vr.ok:
        result.prose = prose
        result.badge = BadgeState.ALL_CITED
        mark("Verify", "ok", f"{vr.checked_numbers} figures traced", t0)
    else:
        result.prose = None
        result.badge = BadgeState.PARTIAL
        mark(
            "Verify", "refused",
            "withheld: " + (", ".join(vr.unmatched_numbers) or "identifier in egress"),
            t0,
        )
    result.verify_result = vr


def _guess_keys(q: str) -> list[str]:
    q = q.lower()
    hits = []
    if "relief" in q:
        hits.append("relief.personal")
    if any(w in q for w in ("band", "rate", "bracket", "percent")):
        hits.append("band.progressive")
    if "epf" in q:
        hits.append("deduction.epf_employee")
    if "apit" in q or "paye" in q:
        hits.append("credit.apit")
    if any(w in q for w in ("deadline", "due", "instalment")):
        hits.append("deadline.return_filing")
    if "qualifying" in q:
        hits.append("deduction.qualifying")
    return hits or ["relief.personal", "band.progressive"]
