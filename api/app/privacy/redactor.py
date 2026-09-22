"""Coded privacy layer — spec §9.1.

Architecture: minimise first, redact second. The strongest control is not
scrubbing text well; it is not sending the text. Intake parses the message into
TaxFacts and downstream nodes receive that, not the original string. This module
handles the free-text remnant that does travel.

Fail-closed: ambiguity redacts. Over-redaction degrades an explanation;
under-redaction leaks a taxpayer's identity. The asymmetry is not close.

spaCy NER is loaded lazily and is optional — en_core_web_sm is ~12 MB, but if it
is not installed the regex tier still runs and the module reports reduced recall
rather than failing open.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol

# --- Money must survive (spec §9.1) ----------------------------------------
# A numeric token is retained if it carries a currency marker, a thousands
# separator, or a decimal. It is a redaction candidate only if it is a bare
# 9- or 12-digit run. Salaries have separators or are ≤7 digits; NICs do not.
_MONEY_CONTEXT = re.compile(
    r"(?i)\b(lkr|rs\.?|rupees?|salary|income|paid|earn|epf|etf|apit|paye|tax|"
    r"withheld|deduct|allowance|bonus|per month|monthly|annual|per annum)\b"
)

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # Email before phone — an email can contain digit runs.
    ("EMAIL", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")),
    # NIC old format: 9 digits + V or X.
    ("NIC", re.compile(r"\b\d{9}[VvXx]\b")),
    # Passport: N or M followed by 7 digits.
    ("PASSPORT", re.compile(r"\b[NnMm]\d{7}\b")),
    # Sri Lankan phone: +94 or leading 0, 9 more digits, common separators.
    ("PHONE", re.compile(r"(?:\+94[\s-]?|\b0)(?:\d[\s-]?){8}\d\b")),
]

# NIC new format: 12 digits, with a birth-date-plausibility check on the day-of-
# year field (positions 5-7) to cut false positives against large bare numbers.
_NIC_NEW = re.compile(r"\b(\d{4})(\d{3})(\d{5})\b")

# Context-dependent: these only fire near a matching keyword, because a bare
# 9-digit run is more often a figure than a TIN.
_TIN = re.compile(r"\b\d{9}\b")
_TIN_CONTEXT = re.compile(r"(?i)\b(tin|taxpayer identification|tax file|t\.i\.n)\b")
_ACCOUNT = re.compile(r"\b\d{8,16}\b")
_ACCOUNT_CONTEXT = re.compile(
    r"(?i)\b(account|a/c|acct|bank|epf (?:member|no)|etf (?:member|no)|member no)\b"
)

# Placeholders already inserted by an earlier tier. NER must not re-enter these.
_PLACEHOLDER = re.compile(r"<[A-Z]+(?:_\d+)?>")

# Public tax vocabulary that en_core_web_sm, trained on English news, tags as
# organisations: "What about EPF?" went out as "What about <EMPLOYER_1>?", which
# cost the planner the subject of the question and retrieval its keyword. These
# name taxes, funds, identifiers and the tax authority. Every taxpayer shares
# them, so they identify no one. An entity is kept only when the WHOLE of it is
# one of these, after dropping a leading "the" and possessives. "Ceylon
# Textiles EPF" is still redacted whole, so fail-closed still holds.
_TAX_TERMS = frozenset({
    "ait", "apit", "cbsl", "cgt", "epf", "esc", "etf", "iit", "ird", "lkr",
    "nbt", "nic", "paye", "ramis", "rs", "sscl", "svat", "tin", "vat", "wht",
    "inland revenue", "inland revenue department", "department of inland revenue",
    "commissioner general of inland revenue", "inland revenue act",
    "provident fund", "employees provident fund",
    "trust fund", "employees trust fund",
    "central bank of sri lanka",
})
_POSSESSIVE = re.compile(r"['’]s\b")
_NOT_WORD = re.compile(r"[^\w\s]")


def _is_tax_term(span: str) -> bool:
    words = _NOT_WORD.sub("", _POSSESSIVE.sub("", span.lower())).split()
    if words[:1] == ["the"]:
        words = words[1:]
    return " ".join(words) in _TAX_TERMS

# A label word immediately preceding its own placeholder, e.g. "NIC <NIC>".
_LABEL_BEFORE_PLACEHOLDER = re.compile(
    r"(?i)\b(nic|n\.i\.c|tin|passport|phone|tel|mobile|email|e-mail|"
    r"account|a/c)\b\s*(?:no\.?|number|is|:)?\s*(<[A-Z]+(?:_\d+)?>)"
)


@dataclass
class RedactedText:
    text: str
    replacements: dict[str, int] = field(default_factory=dict)
    ner_available: bool = True

    @property
    def total(self) -> int:
        return sum(self.replacements.values())

    @property
    def clean(self) -> bool:
        return self.total == 0


class Redactor(Protocol):
    """The interface spec §9.1 promises. A model-based implementation drops in
    behind this later; the coded one becomes the fallback and regression
    baseline."""

    def redact(self, text: str) -> RedactedText: ...


def _nic_new_plausible(m: re.Match[str]) -> bool:
    """Positions 5-7 of a new-format NIC are a day-of-year, offset by 500 for
    women. Valid ranges are 1-366 and 501-866."""
    day = int(m.group(2))
    return 1 <= day <= 366 or 501 <= day <= 866


class CodedRedactor:
    """Deterministic pattern matching + optional spaCy NER."""

    def __init__(self, use_ner: bool = True, gazetteer: set[str] | None = None):
        self._use_ner = use_ner
        self._nlp = None
        self._ner_failed = False
        # Spec §9.1: a gazetteer of common Sri Lankan given names and surnames
        # layered over NER, because en_core_web_sm is trained on English news
        # and under-detects Sinhala and Tamil names.
        self._gazetteer = {g.lower() for g in (gazetteer or set())}

    def _nlp_or_none(self):
        if not self._use_ner or self._ner_failed:
            return None
        if self._nlp is None:
            try:
                import spacy

                self._nlp = spacy.load(
                    "en_core_web_sm", disable=["parser", "lemmatizer", "tagger"]
                )
            except Exception:
                self._ner_failed = True
                return None
        return self._nlp

    def redact(self, text: str) -> RedactedText:
        counts: dict[str, int] = {}
        out = text

        def bump(label: str, n: int = 1) -> None:
            if n:
                counts[label] = counts.get(label, 0) + n

        # --- Tier 1: unambiguous structured identifiers --------------------
        for label, pattern in _PATTERNS:
            out, n = pattern.subn(f"<{label}>", out)
            bump(label, n)

        # --- Tier 2: new-format NIC with plausibility check ----------------
        def _nic_sub(m: re.Match[str]) -> str:
            if _nic_new_plausible(m):
                bump("NIC")
                return "<NIC>"
            return m.group(0)

        out = _NIC_NEW.sub(_nic_sub, out)

        # --- Tier 2b: absorb the label word into its placeholder -----------
        # "NIC <NIC>" carries no information the placeholder does not, and
        # leaving it bare invites NER to tag "NIC" as an organisation.
        out = _LABEL_BEFORE_PLACEHOLDER.sub(r"\2", out)

        # --- Tier 3: context-gated numeric identifiers ---------------------
        if _TIN_CONTEXT.search(out):
            out, n = _TIN.subn("<TIN>", out)
            bump("TIN", n)
        if _ACCOUNT_CONTEXT.search(out):
            out, n = _ACCOUNT.subn("<ACCOUNT>", out)
            bump("ACCOUNT", n)

        # --- Tier 4: names and organisations -------------------------------
        nlp = self._nlp_or_none()
        if nlp is not None:
            out, n = self._redact_entities(nlp, out)
            for label, c in n.items():
                bump(label, c)

        if self._gazetteer:
            out, n = self._redact_gazetteer(out)
            bump("PERSON", n)

        return RedactedText(
            text=out, replacements=counts, ner_available=nlp is not None
        )

    def _redact_entities(self, nlp, text: str) -> tuple[str, dict[str, int]]:
        doc = nlp(text)
        counts: dict[str, int] = {}
        # Stable numbering so pronoun reference survives redaction (spec §9.1).
        seen: dict[str, str] = {}
        spans: list[tuple[int, int, str]] = []

        # Tier-1 placeholders already in the text are off limits. spaCy reads
        # "<NIC>" as an ORG, and re-substituting inside it produced the mangled
        # "<EMPLOYER_1> <<EMPLOYER_2>" instead of a clean "<NIC>".
        protected = [
            (m.start(), m.end()) for m in _PLACEHOLDER.finditer(text)
        ]

        def overlaps_placeholder(start: int, end: int) -> bool:
            return any(start < p_end and end > p_start for p_start, p_end in protected)

        for ent in doc.ents:
            if overlaps_placeholder(ent.start_char, ent.end_char):
                continue
            if _is_tax_term(ent.text):
                continue
            if ent.label_ == "PERSON":
                kind = "PERSON"
            elif ent.label_ == "ORG":
                kind = "EMPLOYER"
            elif ent.label_ in ("GPE", "LOC", "FAC"):
                kind = "LOCATION"
            else:
                continue

            key = f"{kind}:{ent.text.lower()}"
            if key not in seen:
                idx = sum(1 for k in seen if k.startswith(kind)) + 1
                seen[key] = f"<{kind}_{idx}>"
            spans.append((ent.start_char, ent.end_char, seen[key]))
            counts[kind] = counts.get(kind, 0) + 1

        for start, end, token in sorted(spans, reverse=True):
            text = text[:start] + token + text[end:]
        return text, counts

    def _redact_gazetteer(self, text: str) -> tuple[str, int]:
        count = 0
        protected = [(m.start(), m.end()) for m in _PLACEHOLDER.finditer(text)]

        def sub(m: re.Match[str]) -> str:
            nonlocal count
            # Never substitute inside an existing placeholder.
            if any(m.start() < pe and m.end() > ps for ps, pe in protected):
                return m.group(0)
            if m.group(0).lower() in self._gazetteer:
                count += 1
                return "<PERSON>"
            return m.group(0)

        return re.sub(r"\b[A-Z][a-z]+\b", sub, text), count


class EgressScanner:
    """Verify-node egress scan (spec §4.1 node 9, §9.1 compensating controls).

    Catches a leak on the way out as well as on the way in. Structured
    identifiers only — this must never fire on a legitimate tax figure.
    """

    def __init__(self) -> None:
        self._redactor = CodedRedactor(use_ner=False)

    def scan(self, text: str) -> list[str]:
        """Returns the classes of identifier found. Empty means clean."""
        result = self._redactor.redact(text)
        return sorted(result.replacements)


def truncate_for_llm(text: str, cap: int) -> str:
    """Compensating control: a hard cap on how much free text is forwarded."""
    if len(text) <= cap:
        return text
    return text[:cap].rsplit(" ", 1)[0] + " …"
