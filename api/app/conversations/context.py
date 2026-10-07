"""The Context Builder: what earlier turns may contribute to the next one.

History and context are different things. The user can read every turn of a
conversation. The Route model reads only what this module builds: a fixed
window of recent turns, filtered for relevance, re-scanned for identifiers and
capped in length. It never sees an earlier answer.

What goes in
  - up to three earlier questions, redacted when they were stored and
    scanned again here
  - the facts of the latest computed answer: numbers and nothing else
  - the year of assessment of the latest turn that had one
  - the clarifying question, when the newest turn asked one

What never goes in
  - earlier explanations, ledgers, citations, rule values, passages or
    snapshot ids. An earlier answer is neither law nor evidence. Every turn
    resolves its rules against the current snapshot and computes afresh.

The figure check lives here too. With context, the model could carry a number
forward wrongly or work one out itself ("my salary doubled"). Every amount it
returns must trace to something the user actually said.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Sequence

from app.compute.types import TaxFacts
from app.privacy.redactor import CodedRedactor, truncate_for_llm

# Newest messages read for context, however long the thread is. Twelve messages
# is six turns. The cost of building context does not grow with the thread.
WINDOW_MESSAGES = 12
MAX_QUESTIONS = 3
MAX_QUESTION_CHARS = 300
# Cap on all the free text in the block: questions plus a pending clarification.
MAX_CONTEXT_CHARS = 1200

# The numeric TaxFacts fields. Identity fields do not exist on TaxFacts, and
# source, residency and as_of belong to the question that set them.
FACT_FIELDS = (
    "employment_income",
    "business_income",
    "business_expenses",
    "foreign_service_income",
    "investment_income",
    "other_income",
    "epf_employee",
    "qualifying_payments",
    "apit_withheld",
    "foreign_tax_credit",
    "wht_credit",
)

# Facts only carry forward from answers that computed with them.
_FACT_INTENTS = ("compute", "obligation")

# Defence in depth. Stored questions were redacted with NER at Intake; this
# second pass catches any structured identifier before text leaves again.
_SCANNER = CodedRedactor(use_ner=False)

# Rounding slack when comparing a model's float to a stated figure.
_TOLERANCE = Decimal("1")

# A stated amount: "5,000,000", "LKR 500,000", "5 million", "250k", "2.5 lakhs".
# The multiplier must end the word, so the "m" of "monthly" is not a million.
# Intake's _AMOUNT uses the same guard.
_STATED = re.compile(
    r"(?i)(?<!\d)(?<!\d[.,])"
    r"(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?!\d)"
    r"(?:\s*(million|mn|m|k|lakhs?|crores?)(?![a-z]))?"
)
_MULTIPLIER = {
    "k": Decimal("1000"),
    "m": Decimal("1000000"),
    "mn": Decimal("1000000"),
    "million": Decimal("1000000"),
    "lakh": Decimal("100000"),
    "lakhs": Decimal("100000"),
    "crore": Decimal("10000000"),
    "crores": Decimal("10000000"),
}
# "2026/2027" is a year of assessment, not two amounts.
_YEAR_OF_ASSESSMENT = re.compile(r"\b(20\d{2})\s*[/\-–]\s*(20\d{2})\b")


@dataclass(frozen=True)
class ContextRow:
    """One stored message, with what its run recorded. Built by store.py."""

    seq: int
    role: str                         # user | assistant
    kind: str | None = None           # answer | refusal | clarify
    content: str = ""
    intent: str | None = None
    ya: str | None = None
    facts: dict[str, Any] | None = None
    run_id: str | None = None


@dataclass(frozen=True)
class ConversationContext:
    questions: tuple[str, ...] = ()
    facts: dict[str, Decimal] = field(default_factory=dict)
    facts_run_id: str | None = None
    ya: str | None = None
    pending_clarify: str | None = None
    # The questions a pending clarification is about. The next message
    # completes them, so the figures they state count as stated.
    unresolved: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not (self.questions or self.facts or self.ya or self.pending_clarify)

    def summary(self) -> str:
        """One line for the Route trace entry. Counts and ids, no figures."""
        parts = [f"{len(self.questions)} earlier question(s)"]
        if self.facts and self.facts_run_id:
            parts.append(f"facts from run {self.facts_run_id[:8]}")
        if self.ya:
            parts.append(f"year {self.ya}")
        if self.pending_clarify:
            parts.append("replying to a clarification")
        return "context: " + ", ".join(parts)

    def prompt_block(self) -> str:
        """The text the Route model reads before the new question."""
        lines = [
            "CONVERSATION SO FAR (background only. Earlier answers are not "
            "included and are not evidence):"
        ]
        if self.questions:
            lines.append("Earlier questions, oldest first:")
            lines.extend(f"- {q}" for q in self.questions)
        if self.facts:
            lines.append(
                "Facts from the latest computed answer (annual LKR): "
                + ", ".join(f"{k}={v}" for k, v in self.facts.items())
            )
        if self.ya:
            lines.append(f"Year of assessment in use: {self.ya}")
        if self.pending_clarify:
            lines.append(
                f'The assistant then asked: "{self.pending_clarify}" '
                "The new question may be the reply."
            )
        return "\n".join(lines)


def build_context(rows: Sequence[ContextRow]) -> ConversationContext:
    """Turn the newest stored messages into a bounded Route context.

    Pure: no database, no model. `rows` is whatever store.context_rows read,
    in any order.
    """
    window = sorted(rows, key=lambda r: r.seq)[-WINDOW_MESSAGES:]

    # Pair each question with its reply. A window that opens on a reply has
    # cut a turn in half, and that half carries nothing.
    turns: list[tuple[ContextRow, ContextRow]] = []
    question: ContextRow | None = None
    for row in window:
        if row.role == "user":
            question = row
        elif question is not None:
            turns.append((question, row))
            question = None

    questions: list[str] = []
    facts: dict[str, Decimal] = {}
    facts_run_id: str | None = None
    ya: str | None = None

    for asked, reply in turns:
        # A refused question says nothing about the user's situation, and an
        # out of scope question must not steer the next one.
        if reply.kind == "refusal":
            continue
        questions.append(asked.content)
        if reply.ya:
            ya = reply.ya
        if reply.kind == "answer" and reply.intent in _FACT_INTENTS and reply.facts:
            carried = _numeric_facts(reply.facts)
            if carried:
                facts, facts_run_id = carried, reply.run_id

    # A clarification is pending when the newest turn asked one. A reply can
    # itself be clarified again, so the whole run of clarify turns at the end
    # is what the next message completes.
    unresolved: list[str] = []
    for asked, reply in reversed(turns):
        if reply.kind != "clarify":
            break
        unresolved.insert(0, asked.content)
    pending = turns[-1][1].content if unresolved else None

    cleaned = [q for q in (_clean(q) for q in questions) if q][-MAX_QUESTIONS:]
    pending_clean = _clean(pending) if pending else None
    budget = MAX_CONTEXT_CHARS - len(pending_clean or "")
    while cleaned and sum(len(q) for q in cleaned) > budget:
        cleaned.pop(0)

    return ConversationContext(
        questions=tuple(cleaned),
        facts=facts,
        facts_run_id=facts_run_id,
        ya=ya,
        pending_clarify=pending_clean or None,
        unresolved=tuple(q for q in (_clean(q) for q in unresolved[-MAX_QUESTIONS:]) if q),
    )


def _clean(text: str | None) -> str:
    if not text:
        return ""
    scanned = _SCANNER.redact(text).text
    return truncate_for_llm(" ".join(scanned.split()), MAX_QUESTION_CHARS)


def _numeric_facts(stored: dict[str, Any]) -> dict[str, Decimal]:
    """The non-zero numeric fields of a stored TaxFacts dump."""
    out: dict[str, Decimal] = {}
    for name in FACT_FIELDS:
        raw = stored.get(name)
        if raw in (None, ""):
            continue
        try:
            value = Decimal(str(raw))
        except InvalidOperation:
            continue
        if value != 0:
            out[name] = value
    return out


# ---------------------------------------------------------------------------
# Figure check
# ---------------------------------------------------------------------------

def stated_amounts(text: str) -> set[Decimal]:
    """Every amount a text states, as given and as a monthly figure times 12."""
    text = _YEAR_OF_ASSESSMENT.sub(" ", text)
    out: set[Decimal] = set()
    for m in _STATED.finditer(text):
        try:
            value = Decimal(m.group(1).replace(",", ""))
        except InvalidOperation:
            continue
        if m.group(2):
            value *= _MULTIPLIER[m.group(2).lower()]
        if value <= 0:
            continue
        out.add(value)
        out.add(value * 12)
    return out


def check_figures(
    facts: TaxFacts, context: ConversationContext, new_question: str
) -> list[str]:
    """Fields whose amount does not trace to anything the user said.

    An amount traces if it is an earlier fact, a figure the user stated, or an
    earlier fact plus or minus a figure stated now. Zero always traces:
    removing an income is a statement, not an invention.

    Only figures stated now (the new question, and the questions a pending
    clarification is about) may be added to or taken from an earlier fact.
    Figures from earlier questions count only as stated, otherwise "my salary
    doubled" would pass as the earlier salary plus the same salary again.
    """
    stated_now = stated_amounts(new_question)
    for q in context.unresolved:
        stated_now |= stated_amounts(q)
    stated_before: set[Decimal] = set()
    for q in context.questions:
        stated_before |= stated_amounts(q)

    untraced: list[str] = []
    for name in FACT_FIELDS:
        value = getattr(facts, name)
        if value is None or value == 0:
            continue
        if not _traceable(value, context.facts.get(name), stated_now, stated_before):
            untraced.append(name)
    return untraced


def _traceable(
    value: Decimal,
    carried: Decimal | None,
    stated_now: set[Decimal],
    stated_before: set[Decimal],
) -> bool:
    if carried is not None and _close(value, carried):
        return True
    if any(_close(value, s) for s in stated_now | stated_before):
        return True
    if carried is not None:
        return any(
            _close(value, carried + s) or _close(value, carried - s) for s in stated_now
        )
    return False


def apit_is_stale(facts: TaxFacts, context: ConversationContext, new_question: str) -> bool:
    """An APIT carried forward unchanged onto a different salary.

    "My employer deducted APIT of 96,000", then "what if my salary was 400k":
    the 96,000 was deducted from the old salary. Carried onto the new one it
    undercounts the APIT, and the balance comes out too high. A figure the
    new question states is the user's own and stays.
    """
    carried_apit = context.facts.get("apit_withheld")
    carried_salary = context.facts.get("employment_income")
    if facts.apit_withheld is None or carried_apit is None or carried_salary is None:
        return False
    if facts.employment_income is None or _close(facts.employment_income, carried_salary):
        return False
    if not _close(facts.apit_withheld, carried_apit):
        return False
    return not any(_close(facts.apit_withheld, s) for s in stated_amounts(new_question))


def _close(a: Decimal, b: Decimal) -> bool:
    return abs(a - b) <= _TOLERANCE
