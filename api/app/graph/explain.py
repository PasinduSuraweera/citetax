"""Explain node — spec §4.1 node 8.

The LLM writes prose, constrained to the computed ledger and retrieved spans.
It never sees the user's raw message, a name, an employer or an ID number —
only TaxFacts-derived figures, the ledger, and law text.

If Groq is unavailable the node degrades to no prose. Computation and citations
are unaffected (spec §13, Groq availability risk).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.compute.types import Computation
from app.core.config import get_settings
from app.rules.resolver import ResolvedRuleSet

SYSTEM_PROMPT = """You are Citetax, a Sri Lankan personal income tax assistant.

You are writing a short explanation of a tax computation that has ALREADY been
performed by a deterministic engine. Your job is to explain it in plain English.

ABSOLUTE RULES:
1. Use ONLY the figures given to you in the ledger below. Never introduce a
   number that is not in the ledger — not an estimate, not a round figure, not
   an example. Every number you write is machine-checked against the ledger and
   the explanation is discarded if any number does not match.
2. Do not give tax advice, planning suggestions, or recommendations. State what
   the computation shows and what the law says.
3. Do not speculate about rules you were not given.
4. Refer to the year of assessment exactly as written.
5. Be concise: three to five sentences.
6. Do not invent names, employers, or personal details.

Write for a taxpayer who wants to understand where the number came from."""


def build_context(computation: Computation, rules: ResolvedRuleSet) -> str:
    """The only thing the model sees besides the system prompt. No raw user text."""
    lines = [f"YEAR OF ASSESSMENT: {computation.ya}", "", "LEDGER:"]
    for step in computation.steps:
        marker = " (zero)" if step.is_zero else ""
        lines.append(
            f"  Step {step.step_no}: {step.label} = LKR {step.value:,}{marker} "
            f"[rule: {step.rule_key}, cited as {step.citation_label}]"
        )
    lines += [
        "",
        f"TAXABLE INCOME: LKR {computation.taxable_income:,}",
        f"GROSS TAX: LKR {computation.gross_tax:,}",
        f"BALANCE PAYABLE: LKR {computation.balance_payable:,}",
    ]
    if computation.is_refund:
        lines.append("NOTE: this is a refund position (negative balance).")

    band = rules.get("band.progressive")
    if band:
        lines += ["", "BANDS APPLIED:"]
        for b in band.value_json.get("bands", []):
            edge = "and above" if b["upto"] is None else f"up to {int(b['upto']):,}"
            lines.append(f"  {edge}: {_as_percent(b['rate'])}")

    lines += ["", "LAW TEXT (quote from, do not paraphrase figures):"]
    for rv in rules.rules.values():
        if rv.quoted_text:
            lines.append(f"  [{rv.citation_label}] {rv.quoted_text}")

    return "\n".join(lines)


def _as_percent(rate: str) -> str:
    """0.06 → '6%'. The verify node allowlists both forms."""
    return f"{Decimal(str(rate)) * 100:g}%"


def explain(
    computation: Computation,
    rules: ResolvedRuleSet,
    redacted_question: str,
    retry_note: str | None = None,
) -> tuple[str | None, dict[str, Any]]:
    """Returns (prose, meta). prose is None when the LLM is unavailable."""
    settings = get_settings()
    meta: dict[str, Any] = {"model": settings.groq_model, "called": False}

    if not settings.llm_enabled:
        meta["skipped"] = "GROQ_API_KEY not set"
        return None, meta

    user_content = build_context(computation, rules)
    if redacted_question:
        user_content += f"\n\nTHE QUESTION (redacted): {redacted_question}"
    if retry_note:
        user_content += (
            f"\n\nIMPORTANT: your previous attempt contained the figure(s) "
            f"{retry_note}, which are not in the ledger. Rewrite using only "
            f"ledger figures."
        )

    try:
        from groq import Groq

        client = Groq(api_key=settings.groq_api_key)
        resp = client.chat.completions.create(
            model=settings.groq_model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.2,
            # gpt-oss-120b is a reasoning model: reasoning tokens are drawn
            # from this same budget. At 400 the visible answer was truncated
            # mid-figure ("LKR 3"), which verify cannot catch because a prefix
            # of a real number still matches. Budget for both.
            max_tokens=2000,
        )
        meta["called"] = True
        choice = resp.choices[0]
        meta["finish_reason"] = choice.finish_reason

        # A truncated explanation is worse than none: it can end mid-figure and
        # read as a different, smaller number. Discard it and fall back to
        # figures-without-prose.
        if choice.finish_reason == "length":
            meta["error"] = "response truncated (hit max_tokens) — prose discarded"
            return None, meta

        return choice.message.content, meta
    except Exception as exc:  # noqa: BLE001 — degrade to figures-without-prose
        meta["error"] = str(exc)[:200]
        return None, meta
