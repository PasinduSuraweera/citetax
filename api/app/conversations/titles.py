"""Conversation titles, made from the first turn without a model call.

The sidebar is the most visible surface in the app and it stays on screen, so
a title never carries an amount. It names what kind of question the chat
started with and the year, which is enough to find it again. Rename covers the
rest.
"""

from __future__ import annotations

import re

from app.privacy.redactor import CodedRedactor

MAX_TITLE = 60
MAX_RENAMED_TITLE = 120
FALLBACK = "New chat"

_RULE_LABELS = {
    "relief.personal": "Personal relief",
    "band.progressive": "Tax rates and bands",
    "deduction.epf_employee": "EPF deduction",
    "deduction.qualifying": "Qualifying payments",
    "credit.apit": "APIT credit",
    "credit.foreign_wht": "Foreign tax credit",
    "income.assessable": "Assessable income",
    "charge.taxable_income": "Taxable income",
    "deadline.return_filing": "Filing deadlines",
}

_INCOME_LABELS = (
    ("employment_income", "employment income"),
    ("business_income", "freelance income"),
    ("investment_income", "investment income"),
    ("other_income", "other income"),
)

_PLACEHOLDER = re.compile(r"<[A-Z]+(?:_\d+)?>")
# An amount, with its currency marker and multiplier, so it can be elided.
_AMOUNT = re.compile(
    r"(?i)(\b(?:lkr|rs\.?|rupees?)\s*)?(?<!\d)(?<!\d[.,])"
    r"(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?!\d)"
    r"(\s*(?:million|mn|m|k|lakhs?|crores?)(?![a-z]))?"
)
_YEAR_OF_ASSESSMENT = re.compile(r"\b20\d{2}\s*[/\-–]\s*20\d{2}\b")
_SENTENCE_END = re.compile(r"(?<=[?.!])\s")

# Titles are user facing text that stays on screen. A rename can contain
# anything, so structured identifiers are stripped the same way egress is.
_SCANNER = CodedRedactor(use_ner=False)


def short_ya(ya: str | None) -> str | None:
    """2026/2027 -> 2026/27."""
    if not ya or "/" not in ya:
        return ya
    start, end = ya.split("/", 1)
    return f"{start}/{end[-2:]}"


def _with_year(label: str, ya: str | None) -> str:
    y = short_ya(ya)
    return f"{label} · {y}" if y else label


def title_for_turn(
    intent: str | None,
    kind: str,
    ya: str | None,
    facts: dict | None,
    compare: dict | None,
    rule_keys: list[str],
    redacted_question: str,
) -> str:
    """Title for a conversation, from its first turn."""
    if intent == "conversation":
        # Replaced by the first real question's title (store.append_turn).
        return "New chat"
    if kind != "refusal":
        if intent == "compute":
            return _with_year(f"Tax on {_income_label(facts)}", ya)
        if intent == "obligation":
            return _with_year("Do I need to file?", ya)
        if intent == "deadline":
            return _with_year("Filing deadlines", ya)
        if intent == "compare" and compare:
            return (
                f"What changed · {short_ya(compare.get('from_ya'))} → "
                f"{short_ya(compare.get('to_ya'))}"
            )
        if intent == "rule_lookup":
            labels = [_RULE_LABELS[k] for k in rule_keys if k in _RULE_LABELS]
            if labels:
                return _with_year(labels[0], ya)
    return from_question(redacted_question)


def _income_label(facts: dict | None) -> str:
    present = [
        label for key, label in _INCOME_LABELS
        if _nonzero((facts or {}).get(key))
    ]
    if len(present) == 1:
        return present[0]
    if len(present) > 1:
        return "mixed income"
    return "income"


def _nonzero(value) -> bool:
    try:
        return value is not None and float(value) != 0
    except (TypeError, ValueError):
        return False


def from_question(redacted_question: str) -> str:
    """The first sentence of the question, placeholders and amounts removed,
    cut at a word boundary."""
    text = _PLACEHOLDER.sub(" ", redacted_question)
    # Protect the year of assessment from the amount pattern.
    years: list[str] = []

    def keep_year(m: re.Match[str]) -> str:
        years.append(m.group(0))
        return f"\x00{len(years) - 1}\x00"

    text = _YEAR_OF_ASSESSMENT.sub(keep_year, text)
    text = _AMOUNT.sub(_elide_amount, text)
    text = re.sub(r"\x00(\d+)\x00", lambda m: years[int(m.group(1))], text)

    text = " ".join(text.split())
    text = _SENTENCE_END.split(text, maxsplit=1)[0]
    return clamp(text, MAX_TITLE)


def _elide_amount(m: re.Match[str]) -> str:
    """Money goes; a rate, a count or a bare year stays."""
    currency, number, multiplier = m.group(1), m.group(2), m.group(3)
    if currency or multiplier:
        return "…"
    value = float(number.replace(",", ""))
    if value >= 1000 and not (2000 <= value <= 2100 and "," not in number):
        return "…"
    return m.group(0)


def clamp(text: str, limit: int) -> str:
    text = " ".join(text.split()).strip(" ,;:-")
    if len(text) <= limit:
        return text or FALLBACK
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:-")
    return (cut or text[: limit - 1]) + "…"


def clean_rename(title: str) -> str:
    """A user supplied title: identifiers stripped, whitespace collapsed,
    bounded. Returns "" when nothing is left."""
    text = "".join(ch for ch in title if ch.isprintable())
    text = _SCANNER.redact(text).text
    text = " ".join(text.split())
    if not text:
        return ""
    return clamp(text, MAX_RENAMED_TITLE)
