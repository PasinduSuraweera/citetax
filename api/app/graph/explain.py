"""Explain node (spec section 4.1 node 8).

The model writes prose constrained to what it is handed: a computed ledger, the
resolved law text, retrieved passages. It never sees a raw user message, a name,
an employer or an ID number.

One function, several intents. The system prompt changes with the intent, the
constraint does not: every figure the model writes is machine checked against
the material it was given, and the explanation is discarded if any figure fails.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from app.compute.types import Computation
from app.core import llm
from app.graph.comply import Compliance
from app.retrieval.search import Passage
from app.rules.resolver import ResolvedRuleSet, RuleVersion

BASE_RULES = """ABSOLUTE RULES:
1. Use ONLY figures that appear in the material below: the ledger, the rule values, the law text, the retrieved passages. Never introduce a number that is not there: no estimates, no round examples, no figures from memory. Every number you write is machine checked and the whole explanation is discarded if one does not match.
1a. Do NO arithmetic of your own. Never write a figure you obtained by adding, subtracting, multiplying or dividing two figures from the material, even if the sum is obvious. If you want to say income is below the relief threshold, name the two figures and say "below"; do not write the difference. Every intermediate you need already appears as a ledger step; use that step's value.
2. Give no tax advice, no planning suggestions, no recommendations about what the reader should do. Say what the law provides and what the computation shows.
3. Do not speculate about rules you were not given. If the material does not answer the question, say what it does cover and stop.
4. Write the year of assessment exactly as given, e.g. 2026/2027.
5. Do not invent names, employers or personal details. Placeholders like <PERSON_1> mean a name was removed; do not refer to them.
6. When you rely on a rule, name its citation label in brackets, e.g. (Act s.52).
6a. When you rely on a retrieved passage, cite it by its number alone in square brackets, e.g. [2], placed before the full stop. Never write a passage's title, site name or bracketed label in the prose.
7. Plain English for a Sri Lankan taxpayer. Short sentences. No headings, no bullet points, no markdown."""

PROMPTS: dict[str, str] = {
    "compute": (
        "You are Citetax. A deterministic engine has already computed this "
        "taxpayer's balance. Explain in three to five sentences where the figure "
        "came from, walking the ledger in order and naming the rule for each step "
        "that changed the number. Mention the filing deadline once."
    ),
    "obligation": (
        "You are Citetax. Explain in two to four sentences whether this taxpayer "
        "must file a return and why. Use the ledger's assessable income, the "
        "personal relief amount, and the ledger's taxable income figure exactly as "
        "written; do not subtract one from another. State the return due date and "
        "the rule that sets it."
    ),
    "deadline": (
        "You are Citetax. Answer the question about dates in two to four sentences "
        "using only the deadline rule and passages given. Name the return due date, "
        "the instalment dates if asked or relevant, and the rule that sets them."
    ),
    "compare": (
        "You are Citetax. Explain in three to five sentences what differs between "
        "the two years of assessment shown, rule by rule. Where a rule is unchanged, "
        "say so briefly. Where it changed, name the old value, the new value, and "
        "the citation. If the comparison shows only the filing dates moved, say "
        "that plainly."
    ),
    "rule_lookup": (
        "You are Citetax. State the rule the user asked about in two to four "
        "sentences: its value, when it took effect, and its citation. Quote the law "
        "text where it helps. Do not compute anything for the user."
    ),
    "general": (
        "You are Citetax. Answer the conceptual question in three to six sentences "
        "using only the law text and passages provided. Cite the rule label for "
        "each point. If the material does not cover part of the question, say so "
        "rather than filling the gap."
    ),
}


@dataclass
class ExplainContext:
    intent: str
    ya: str | None
    redacted_question: str
    rules: ResolvedRuleSet | None = None
    computation: Computation | None = None
    compliance: Compliance | None = None
    passages: list[Passage] = field(default_factory=list)
    compare: dict[str, Any] | None = None
    lookup: list[RuleVersion] = field(default_factory=list)
    days_remaining: int | None = None


def _pct(rate: Any) -> str:
    return f"{Decimal(str(rate)) * 100:g}%"


# The model emits typographic dashes and hyphens (U+2010 to U+2015, U+2212)
# inside dates and compound words. Verify scans for ASCII, and a date written
# "2027‑11‑30" with a non breaking hyphen would otherwise fall apart into three
# allowlisted integers and pass unchecked. Normalise before anything reads it.
_DASHES = str.maketrans({c: "-" for c in "‐‑‒–—―−"})


def _normalise(text: str) -> str:
    return (text or "").translate(_DASHES).replace(" ", " ").strip()


def _describe_value(rule_key: str, value: dict[str, Any]) -> str:
    if "bands" in value:
        parts = []
        for b in value["bands"]:
            edge = "and above" if b.get("upto") is None else f"up to LKR {int(b['upto']):,}"
            parts.append(f"{edge} at {_pct(b['rate'])}")
        return "; ".join(parts)
    if "amount" in value:
        return f"LKR {int(Decimal(str(value['amount']))):,}"
    if "due" in value:
        s = f"return due {value['due']}"
        if value.get("instalments"):
            s += ", instalments " + ", ".join(value["instalments"])
        return s
    if "employee_rate" in value:
        return _pct(value["employee_rate"])
    if "annual_cap" in value:
        return "no cap" if value["annual_cap"] is None else f"cap LKR {value['annual_cap']}"
    return ", ".join(f"{k}: {v}" for k, v in value.items() if k != "citation_label")


def build_context(ctx: ExplainContext) -> str:
    lines: list[str] = []
    if ctx.ya:
        lines += [f"YEAR OF ASSESSMENT: {ctx.ya}", ""]

    if ctx.computation:
        c = ctx.computation
        lines.append("LEDGER (computed by a deterministic engine):")
        for s in c.steps:
            marker = " (nil)" if s.is_zero else ""
            line = f"  Step {s.step_no}: {s.label} = LKR {s.value:,}{marker} [{s.citation_label}]"
            d = s.detail or {}
            if d.get("capped"):
                statutory = Decimal(str(d["statutory"]))
                line += (
                    f"  NOTE: the statutory personal relief is LKR {statutory:,}; "
                    f"only LKR {s.value:,} of it is applied because relief cannot "
                    f"exceed the income left after deductions. Say 'the personal "
                    f"relief of LKR {statutory:,}' and, if needed, 'of which LKR "
                    f"{s.value:,} is applied'. Never call {s.value:,} the relief."
                )
            lines.append(line)
        lines += [
            f"  TAXABLE INCOME: LKR {c.taxable_income:,}",
            f"  GROSS TAX: LKR {c.gross_tax:,}",
            f"  {'REFUND DUE' if c.is_refund else 'BALANCE PAYABLE'}: LKR {abs(c.balance_payable):,}",
            "",
        ]

    if ctx.compliance:
        cp = ctx.compliance
        lines.append("FILING:")
        lines.append(f"  must file: {'yes' if cp.must_file else 'no'}. {cp.reason}")
        if cp.return_due:
            lines.append(f"  return due: {cp.return_due} [{cp.citation_label}]")
        if ctx.days_remaining is not None:
            lines.append(f"  days remaining until the return is due: {ctx.days_remaining}")
        if cp.instalments:
            lines.append("  instalments: " + ", ".join(cp.instalments))
        lines.append("")

    if ctx.compare:
        cmp = ctx.compare
        lines.append(f"COMPARISON {cmp['from_ya']} versus {cmp['to_ya']}:")
        for ch in cmp["changes"]:
            if ch["changed"]:
                lines.append(
                    f"  {ch['rule_key']}: CHANGED. {cmp['from_ya']}: "
                    f"{_describe_value(ch['rule_key'], ch['from']['value'])} "
                    f"[{ch['from']['citation_label']}]. {cmp['to_ya']}: "
                    f"{_describe_value(ch['rule_key'], ch['to']['value'])} "
                    f"[{ch['to']['citation_label']}]."
                )
            else:
                lines.append(
                    f"  {ch['rule_key']}: unchanged, "
                    f"{_describe_value(ch['rule_key'], ch['to']['value'])} "
                    f"[{ch['to']['citation_label']}]"
                )
        lines.append("")

    if ctx.lookup:
        lines.append("RULES ASKED ABOUT:")
        for rv in ctx.lookup:
            eff = f"in force from {rv.effective_from.isoformat()}"
            if rv.effective_to:
                eff += f" to {rv.effective_to.isoformat()}"
            lines.append(
                f"  {rv.rule_key} [{rv.citation_label}]: "
                f"{_describe_value(rv.rule_key, rv.value_json)}; {eff}"
            )
        lines.append("")

    if ctx.rules:
        lines.append("LAW TEXT (quote from, do not paraphrase figures):")
        for rv in ctx.rules.rules.values():
            if rv.quoted_text:
                lines.append(f"  [{rv.citation_label}] {rv.quoted_text}")
        lines.append("")

    if ctx.passages:
        lines.append("RETRIEVED PASSAGES (from the published corpus):")
        for i, p in enumerate(ctx.passages, 1):
            label = p.title or p.rule_key or "corpus"
            lines.append(f"  ({i}) [{label}] {p.text[:700]}")
        lines.append("")

    if ctx.redacted_question:
        lines.append(f"THE QUESTION (identifiers removed): {ctx.redacted_question}")

    return "\n".join(lines)


def explain(
    ctx: ExplainContext,
    retry_note: str | None = None,
    budget: llm.LLMBudget | None = None,
) -> tuple[str | None, dict[str, Any]]:
    """Returns (prose, meta). prose is None when the model cannot be used."""
    meta: dict[str, Any] = {"intent": ctx.intent, "called": False}

    if not llm.available():
        meta["skipped"] = "GROQ_API_KEY not set"
        return None, meta

    system = f"{PROMPTS.get(ctx.intent, PROMPTS['general'])}\n\n{BASE_RULES}"
    user = build_context(ctx)
    if retry_note:
        user += (
            f"\n\nIMPORTANT: your previous attempt contained the figure(s) "
            f"{retry_note}, which are not in the material above. Most often this "
            f"is a figure you computed yourself, such as a difference or a sum. "
            f"Rewrite using only figures that appear above, verbatim, and do no "
            f"arithmetic."
        )

    try:
        prose, call = llm.complete(
            system, user, max_tokens=2000, temperature=0.2, budget=budget
        )
        meta.update(call.to_json())
        meta["called"] = True
        return _normalise(prose) or None, meta
    except llm.LLMUnavailable as exc:
        meta["called"] = True
        meta["error"] = str(exc)[:200]
        return None, meta
