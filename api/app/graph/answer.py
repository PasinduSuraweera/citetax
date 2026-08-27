"""The answer graph — spec §4.1, nodes 1-9.

Written as an explicit sequential pipeline rather than a LangGraph StateGraph.
The graph is linear with two early exits (scope refusal, clarify), so a plain
function is more readable and more testable than a node registry, and it keeps
the trace construction obvious. Swapping in LangGraph later means wrapping each
`_node_*` function; the signatures are already shaped for it.

Order matters and is not the obvious one: **retrieval comes after computation**.
Computation reads the rules table, never the search index. Search is for prose
the user reads, never for numbers the user relies on.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.engine import Connection

from app.compute.engine import REQUIRED_RULE_KEYS, compute
from app.compute.types import Computation, TaxFacts
from app.core.config import get_settings
from app.graph import comply, explain as explain_mod, intake, scope
from app.graph.verify import BadgeState, VerifyResult, verify
from app.privacy.redactor import CodedRedactor, truncate_for_llm
from app.rules.resolver import (
    AmbiguousRule,
    ResolvedRuleSet,
    UnresolvedRule,
    current_snapshot,
    resolve_many,
)


@dataclass
class TraceEntry:
    node: str
    status: str            # ok | refused | skipped | failed
    detail: str | None = None
    ms: int = 0

    def to_json(self) -> dict[str, Any]:
        return {"node": self.node, "status": self.status,
                "detail": self.detail, "ms": self.ms}


@dataclass
class AnswerResult:
    kind: str                      # answer | refusal | clarify
    ya: str | None = None
    computation: Computation | None = None
    compliance: comply.Compliance | None = None
    rules: ResolvedRuleSet | None = None
    prose: str | None = None
    verify_result: VerifyResult | None = None
    badge: BadgeState = BadgeState.ALL_CITED
    refusal_reason: str | None = None
    refusal_pointer: str | None = None
    clarify_question: str | None = None
    facts: TaxFacts | None = None
    snapshot: dict[str, Any] | None = None
    trace: list[TraceEntry] = field(default_factory=list)
    latency_ms: int = 0
    model_meta: dict[str, Any] = field(default_factory=dict)


_REDACTOR = CodedRedactor(use_ner=True)

_CLARIFY_PROMPTS = {
    "ya": "Which year of assessment are you asking about — 2025/2026 or 2026/2027?",
    "income": "What was your total income for the year? A monthly salary figure is fine.",
}


def run_answer_graph(
    conn: Connection,
    question: str,
    ya_override: str | None = None,
    facts_override: TaxFacts | None = None,
) -> AnswerResult:
    settings = get_settings()
    started = time.perf_counter()
    trace: list[TraceEntry] = []
    result = AnswerResult(kind="answer", trace=trace)

    def mark(node: str, status: str, detail: str | None = None, t0: float | None = None):
        ms = int((time.perf_counter() - (t0 or started)) * 1000)
        trace.append(TraceEntry(node=node, status=status, detail=detail, ms=ms))

    def finish(res: AnswerResult) -> AnswerResult:
        res.latency_ms = int((time.perf_counter() - started) * 1000)
        res.trace = trace
        return res

    # --- Node 1: Intake — redact, parse, minimise --------------------------
    t0 = time.perf_counter()
    redacted = _REDACTOR.redact(question)
    if facts_override is not None:
        facts = facts_override
    else:
        facts = intake.parse_question(question, settings.supported_yas)
    if ya_override:
        facts.ya = ya_override
    result.facts = facts
    mark(
        "Intake",
        "ok",
        f"{redacted.total} identifier(s) redacted"
        + ("" if redacted.ner_available else "; NER model unavailable"),
        t0,
    )

    # --- Node 2: Scope gate ------------------------------------------------
    # Classifies the ORIGINAL text, not the redacted text. spaCy tags "VAT" as
    # an ORG, so redaction rewrites it to <EMPLOYER_1> and the gate goes blind
    # to the very word it exists to catch. This runs in-process against fixed
    # patterns — nothing leaves the machine — so the raw string is safe here.
    # Only text bound for the hosted model is redacted (node 8).
    t0 = time.perf_counter()
    verdict = scope.check_scope(question, facts.ya, settings.supported_yas)
    if not verdict.in_scope:
        mark("Scope gate", "refused", verdict.reason, t0)
        result.kind = "refusal"
        result.badge = BadgeState.CANNOT_ANSWER
        result.refusal_reason = verdict.reason
        result.refusal_pointer = verdict.pointer
        return finish(result)
    mark("Scope gate", "ok", "personal income tax, supported year", t0)

    # --- Node 3: Clarify — ask exactly one question and stop ---------------
    t0 = time.perf_counter()
    missing = facts.missing_required()
    if missing:
        field_name = missing[0]
        mark("Clarify", "ok", f"missing: {field_name}", t0)
        result.kind = "clarify"
        result.clarify_question = _CLARIFY_PROMPTS.get(
            field_name, f"Could you tell me your {field_name}?"
        )
        return finish(result)
    mark("Clarify", "skipped", "all required facts present", t0)

    # --- Node 4: Resolve — deterministic, no LLM --------------------------
    t0 = time.perf_counter()
    snapshot = current_snapshot(conn)
    if snapshot is None:
        mark("Resolve", "failed", "no current corpus snapshot", t0)
        result.kind = "refusal"
        result.badge = BadgeState.CANNOT_ANSWER
        result.refusal_reason = (
            "No corpus snapshot is published. The rules database has not been "
            "seeded."
        )
        return finish(result)

    result.snapshot = {
        "id": str(snapshot["id"]),
        "label": snapshot["label"],
        "changelog": snapshot.get("changelog"),
    }
    result.ya = facts.ya

    needed = REQUIRED_RULE_KEYS + ["deadline.return_filing"]
    try:
        rules = resolve_many(
            conn, needed, facts.ya, str(snapshot["id"]), as_of=facts.as_of
        )
    except UnresolvedRule as exc:
        mark("Resolve", "refused", str(exc), t0)
        result.kind = "refusal"
        result.badge = BadgeState.CANNOT_ANSWER
        result.refusal_reason = (
            f"No rule in force found for {exc.rule_key} in year of assessment "
            f"{exc.ya}. Citetax will not guess a figure."
        )
        return finish(result)
    except AmbiguousRule as exc:
        # Data-integrity alarm — block the answer (spec §3.6).
        mark("Resolve", "failed", str(exc), t0)
        result.kind = "refusal"
        result.badge = BadgeState.CANNOT_ANSWER
        result.refusal_reason = (
            "The corpus contains conflicting rule versions for this year. The "
            "answer is blocked and an administrator has been notified."
        )
        return finish(result)

    result.rules = rules
    mark("Resolve", "ok", f"{len(rules.rules)} rules at snapshot {snapshot['label']}", t0)

    # --- Node 5: Compute — pure Python ------------------------------------
    t0 = time.perf_counter()
    computation = compute(facts, rules)
    result.computation = computation
    mark("Compute", "ok", f"{len(computation.steps)} steps", t0)

    # --- Node 6: Comply ----------------------------------------------------
    t0 = time.perf_counter()
    compliance = comply.assess(computation, rules)
    result.compliance = compliance
    mark("Comply", "ok", "must file" if compliance.must_file else "no filing obligation", t0)

    # --- Node 7: Retrieve (explanation only) ------------------------------
    # Deferred to Phase 7. The quoted_text on each resolved rule version is
    # already sufficient context for the Explain node, and retrieval must never
    # influence a number.
    t0 = time.perf_counter()
    mark("Retrieve", "skipped", "using quoted source text from resolved rules", t0)

    # --- Node 8: Explain ---------------------------------------------------
    t0 = time.perf_counter()
    skeleton = truncate_for_llm(redacted.text, settings.max_free_text_to_llm)
    prose, meta = explain_mod.explain(computation, rules, skeleton)
    result.model_meta = meta
    if prose is None:
        mark("Explain", "skipped", meta.get("skipped") or meta.get("error"), t0)
    else:
        mark("Explain", "ok", f"{len(prose)} chars", t0)

    # --- Node 9: Verify ----------------------------------------------------
    t0 = time.perf_counter()
    if prose is None:
        # No prose to verify. The figures are still fully cited.
        result.prose = None
        result.badge = BadgeState.ALL_CITED
        result.verify_result = VerifyResult(
            badge=BadgeState.ALL_CITED,
            ok=True,
            prose_released=False,
            note="Explanation unavailable — figures below are verified.",
        )
        mark("Verify", "ok", "no prose; ledger verified by construction", t0)
        return finish(result)

    vr = verify(prose, computation, rules, attempt=1)
    if not vr.ok:
        # Spec §4.2 item 5 — regenerate once, naming the offending token.
        retry_note = ", ".join(vr.unmatched_numbers) or "an identifier"
        prose2, meta2 = explain_mod.explain(computation, rules, skeleton, retry_note)
        result.model_meta = {**meta, "retry": meta2}
        if prose2 is not None:
            vr = verify(prose2, computation, rules, attempt=2)
            if vr.ok:
                prose = prose2

    if vr.ok:
        result.prose = prose
        result.badge = BadgeState.ALL_CITED
        mark("Verify", "ok", "every figure traced to a rule", t0)
    else:
        # Second failure — release the ledger and citations WITHOUT the prose.
        result.prose = None
        result.badge = BadgeState.PARTIAL
        mark(
            "Verify",
            "refused",
            f"withheld: {', '.join(vr.unmatched_numbers) or 'PII in egress'}",
            t0,
        )

    result.verify_result = vr
    return finish(result)
