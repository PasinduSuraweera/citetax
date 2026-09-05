"""Intent router: the node that decides what the graph does next.

One LLM call reads the redacted question and returns, together:
  - the intent (what kind of help is wanted)
  - whether it is in scope, and why not if not
  - the tax facts it states, in annual LKR
  - which required facts are missing, and one natural clarifying question

This is the piece that stops the graph running the same nine nodes for every
question. A deadline question does not need a computation. A "what changed"
question needs a year diff. A rule lookup needs retrieval, not arithmetic.

The deterministic parsers in intake.py and scope.py stay as the fallback when
the model is unavailable, and as a cross check: a scope refusal from the regex
gate is always honoured even if the model disagrees, because the regex is the
conservative side and refusing is the safe failure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.compute.types import TaxFacts
from app.core import llm
from app.graph import intake, scope

Intent = Literal[
    "compute",        # how much do I owe, what is my tax, balance payable
    "obligation",     # do I need to file
    "deadline",       # when is it due, instalment dates
    "compare",        # what changed between years, difference
    "rule_lookup",    # what is the personal relief, what are the bands
    "general",        # a question about how personal income tax works
    "out_of_scope",   # not personal income tax, advisory, other year
]


class ExtractedFacts(BaseModel):
    """Annual LKR figures. Monthly amounts are multiplied by 12 by the model."""

    employment_income: float | None = Field(None, description="Annual salary, LKR")
    business_income: float | None = Field(None, description="Annual freelance or business income, LKR")
    investment_income: float | None = Field(None, description="Annual interest, dividends, rent, LKR")
    other_income: float | None = None
    epf_employee: float | None = Field(None, description="Employee EPF contribution actually stated, LKR. null if only 'EPF deducted' with no amount")
    apit_withheld: float | None = Field(None, description="APIT or PAYE already withheld, LKR")
    qualifying_payments: float | None = None
    foreign_tax_credit: float | None = None
    wht_credit: float | None = None


class RoutedQuestion(BaseModel):
    intent: Intent
    in_scope: bool
    scope_reason: str | None = Field(
        None, description="If out of scope, one sentence saying why, for the user"
    )
    scope_category: str | None = Field(
        None, description="If out of scope: VAT | SSCL | corporate | advisory | representation | employer-filing | unsupported-year | unrelated"
    )
    year_of_assessment: str | None = Field(
        None, description="Exactly '2025/2026' or '2026/2027' if stated or clearly implied, else null"
    )
    compare_from: str | None = Field(None, description="For compare intent: earlier year")
    compare_to: str | None = Field(None, description="For compare intent: later year")
    rule_keys: list[str] = Field(
        default_factory=list,
        description="For rule_lookup or general: which rule keys are relevant, from the allowed list",
    )
    as_of_date: str | None = Field(
        None, description="ISO date if the question is about a specific date within the year, else null"
    )
    facts: ExtractedFacts = Field(default_factory=ExtractedFacts)
    missing: list[str] = Field(
        default_factory=list,
        description="Required facts not given, from: year_of_assessment, income",
    )
    clarify_question: str | None = Field(
        None,
        description="If something is missing, ONE short natural question asking for the single most important missing fact",
    )
    confidence: float = Field(0.8, ge=0, le=1)


RULE_KEYS = [
    ("income.assessable", "what counts as assessable income"),
    ("deduction.epf_employee", "EPF employee contribution deduction"),
    ("deduction.qualifying", "qualifying payments and deductions"),
    ("relief.personal", "personal relief amount"),
    ("charge.taxable_income", "how taxable income is arrived at"),
    ("band.progressive", "tax rate bands and percentages"),
    ("credit.foreign_wht", "foreign tax and withholding tax credits"),
    ("credit.apit", "APIT credit for tax already deducted by employer"),
    ("deadline.return_filing", "return filing deadline and instalment dates"),
]

SYSTEM = """You are the intake and routing step of Citetax, a Sri Lankan personal income tax assistant.

You receive ONE user question. Personal identifiers have already been replaced with placeholders like <PERSON_1>; ignore them.

Your job is to classify and extract. You do NOT compute tax and you do NOT answer the question.

SCOPE (in_scope=true only if ALL hold):
- The question is about Sri Lankan PERSONAL income tax for an individual (employment, freelance, investment, other income; APIT credit; EPF treatment; relief; bands; filing; deadlines; instalments; penalties).
- It is NOT about VAT, SSCL, corporate/company tax, stamp duty, NBT, or an EMPLOYER'S OWN duties to deduct, remit or file APIT/PAYE for staff ("as an employer", "for my employees", "our payroll"). A question from or about an EMPLOYEE'S side ("how does APIT work for a salaried employee", "how much APIT was withheld from my salary", "can I claim the APIT my employer deducted") is the individual's own tax and IS in scope.
- It is NOT asking for advice on what to do, how to reduce/avoid/minimise tax, planning, or structuring. Asking "how much do I owe" is fine; asking "how should I structure my income" is advisory and out of scope.
- It is NOT about appeals, disputes, assessments notices, or representation before the IRD.
- If a year of assessment is stated, it is 2025/2026 or 2026/2027. Any other year is out of scope with scope_category "unsupported-year".
A general greeting or a question unrelated to tax is out of scope with scope_category "unrelated".

INTENT:
- compute: they want a tax figure or balance payable for their situation.
- obligation: they want to know whether they must file a return.
- deadline: they want dates: when the return is due, instalment dates.
- compare: they want to know what changed between the two years, or the difference.
- rule_lookup: they want the value or text of a specific rule (what is the personal relief, what are the bands).
- general: a conceptual question about how personal income tax works, with no figure for their own situation.
- out_of_scope: anything failing the scope test.

FACTS: give annual LKR amounts as numbers. A monthly figure is multiplied by 12. "1.2 million" is 1200000. "250k" is 250000. If EPF is mentioned without an amount, leave epf_employee null. If only one income figure appears and its type is unclear, treat it as employment_income.

YEAR: "2026/27", "2026-2027", "26/27", "for 2026", "this year" (today is in Y/A 2026/2027) all mean 2026/2027. "last year" means 2025/2026.

MISSING and CLARIFY: only for compute and obligation intents. compute needs year_of_assessment and income. obligation needs year_of_assessment and income. For deadline, compare, rule_lookup, general, missing must be empty. If the year is missing, ask for the year. If income is missing, ask for it. Ask ONE question, short and natural, no preamble.

RULE_KEYS: for rule_lookup and general, list the relevant rule keys from this allowed list only:
""" + "\n".join(f"  {k}: {d}" for k, d in RULE_KEYS)


@dataclass
class RouteResult:
    routed: RoutedQuestion
    facts: TaxFacts
    source: str                       # "llm" | "regex"
    llm_call: dict[str, Any] | None = None
    notes: list[str] = field(default_factory=list)


def _to_facts(r: RoutedQuestion, supported: tuple[str, ...]) -> TaxFacts:
    f = r.facts
    facts = TaxFacts(source="question")

    def dec(v: float | None) -> Decimal | None:
        if v is None:
            return None
        return Decimal(str(round(v, 2)))

    facts.employment_income = dec(f.employment_income)
    facts.business_income = dec(f.business_income) or Decimal(0)
    facts.investment_income = dec(f.investment_income) or Decimal(0)
    facts.other_income = dec(f.other_income) or Decimal(0)
    facts.epf_employee = dec(f.epf_employee)
    facts.apit_withheld = dec(f.apit_withheld) or Decimal(0)
    facts.qualifying_payments = dec(f.qualifying_payments) or Decimal(0)
    facts.foreign_tax_credit = dec(f.foreign_tax_credit) or Decimal(0)
    facts.wht_credit = dec(f.wht_credit) or Decimal(0)

    if r.year_of_assessment in supported:
        facts.ya = r.year_of_assessment  # type: ignore[assignment]
    if r.as_of_date:
        try:
            facts.as_of = date.fromisoformat(r.as_of_date)
        except ValueError:
            pass
    return facts


def _regex_route(
    question: str, supported: tuple[str, ...]
) -> RouteResult:
    """The fallback: the deterministic parsers, expressed as a route."""
    facts = intake.parse_question(question, supported)
    verdict = scope.check_scope(question, facts.ya, supported)

    q = question.lower()
    if not verdict.in_scope:
        intent: Intent = "out_of_scope"
    elif any(w in q for w in ("when", "due", "deadline", "instalment", "installment")):
        intent = "deadline"
    elif any(w in q for w in ("what changed", "difference between", "compare", "changed this year")):
        intent = "compare"
    elif any(w in q for w in ("do i need to file", "must i file", "have to file", "need to file")):
        intent = "obligation"
    elif facts.total_income > 0 or any(w in q for w in ("owe", "how much tax", "my tax", "balance")):
        intent = "compute"
    elif any(w in q for w in ("what is the", "what are the", "how much is the")):
        intent = "rule_lookup"
    else:
        intent = "general"

    missing = facts.missing_required() if intent in ("compute", "obligation") else []
    clarify = None
    if missing:
        clarify = {
            "ya": "Which year of assessment are you asking about, 2025/2026 or 2026/2027?",
            "income": "What was your total income for the year? A monthly salary figure is fine.",
        }.get(missing[0])

    routed = RoutedQuestion(
        intent=intent,
        in_scope=verdict.in_scope,
        scope_reason=verdict.reason,
        scope_category=verdict.category,
        year_of_assessment=facts.ya,
        missing=["year_of_assessment" if m == "ya" else m for m in missing],
        clarify_question=clarify,
        confidence=0.5,
    )
    return RouteResult(routed=routed, facts=facts, source="regex")


def route(
    redacted_question: str,
    original_question: str,
    supported: tuple[str, ...],
    budget: llm.LLMBudget | None = None,
) -> RouteResult:
    """Classify, extract and plan. LLM first, regex as fallback and cross check.

    `redacted_question` goes to the model. `original_question` is used only by
    the in-process regex gate, which needs the tax type words that redaction
    can destroy (spaCy tags "VAT" as an organisation).
    """
    fallback = _regex_route(original_question, supported)

    if not llm.available():
        fallback.notes.append("model unavailable, regex route")
        return fallback

    try:
        routed, call = llm.structured(
            RoutedQuestion, SYSTEM, redacted_question,
            max_tokens=1500, budget=budget,
        )
    except llm.LLMUnavailable as exc:
        fallback.notes.append(f"model failed ({str(exc)[:80]}), regex route")
        return fallback

    notes: list[str] = []

    # The regex gate is the conservative side. If it refuses, we refuse, even
    # when the model would have answered. Refusing is the safe failure.
    regex_verdict = scope.check_scope(original_question, routed.year_of_assessment, supported)
    if not regex_verdict.in_scope and routed.in_scope:
        routed.in_scope = False
        routed.intent = "out_of_scope"
        routed.scope_reason = regex_verdict.reason
        routed.scope_category = regex_verdict.category
        notes.append("regex gate overrode model: refused")

    # The other direction: the model occasionally refuses a plainly on-topic
    # question as "unrelated". When the regex gate finds no out-of-scope pattern
    # AND the text carries income tax vocabulary, that refusal is a false
    # positive, and the safe answer is a grounded general explanation rather
    # than a refusal. Refusals for advisory, VAT, corporate and the like stand:
    # those are the model catching what the regex may have missed.
    #
    # The same applies to "employer-filing": the regex gate has an explicit
    # pattern for employer phrasing ("as an employer", "for my employees",
    # "payroll"). When that pattern did not fire, the model has read "for a
    # salaried employee" as the employer's side, which it is not. Refusals for
    # advisory, representation, VAT, corporate and unsupported year stand.
    if (
        not routed.in_scope
        and routed.scope_category in (None, "unrelated", "employer-filing")
        and regex_verdict.in_scope
        and scope.looks_like_tax_question(original_question)
    ):
        overridden = routed.scope_category or "unrelated"
        routed.in_scope = True
        routed.intent = "general"
        routed.scope_reason = None
        routed.scope_category = None
        notes.append(
            f"model refused as {overridden}; regex sees tax vocabulary and no "
            f"{overridden} pattern, routed general"
        )

    # An unsupported year the model let through is still refused.
    if routed.year_of_assessment and routed.year_of_assessment not in supported:
        routed.in_scope = False
        routed.intent = "out_of_scope"
        routed.scope_category = "unsupported-year"
        routed.scope_reason = (
            f"Citetax supports the years of assessment {' and '.join(supported)} "
            f"only. You asked about {routed.year_of_assessment}."
        )

    facts = _to_facts(routed, supported)

    # Recompute missing from the typed facts rather than trusting the model's
    # list, so the two cannot disagree.
    if routed.intent in ("compute", "obligation") and routed.in_scope:
        missing = facts.missing_required()
        routed.missing = ["year_of_assessment" if m == "ya" else m for m in missing]
        if missing and not routed.clarify_question:
            routed.clarify_question = fallback.routed.clarify_question
        if not missing:
            routed.clarify_question = None
    else:
        routed.missing = []
        routed.clarify_question = None

    return RouteResult(
        routed=routed, facts=facts, source="llm",
        llm_call=call.to_json(), notes=notes,
    )
