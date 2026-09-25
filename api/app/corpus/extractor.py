"""LLM assisted extraction (spec section 3.3).

Reads a document's text and proposes rule changes. Its output is a PROPOSAL,
never a fact: it writes to change_proposal and nothing else. The only path from
proposal to rule_version is a human clicking approve.

The model is given the exact value_json shape each rule key uses, so what it
proposes fits the compute engine without a reviewer retyping it. It is also told
to quote the sentence each value came from, because the reviewer's job is to
compare the quote to the field, not to re-read the document.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.engine import Connection

from app.core import llm

logger = logging.getLogger(__name__)

EXTRACTOR_VERSION = "llm-1.1"

# Same threshold the watcher uses to skip listings.
LISTING_LINK_SHARE = 0.9

# The shapes the compute engine reads. Given to the model verbatim.
RULE_SHAPES: dict[str, dict[str, Any]] = {
    "relief.personal": {"amount": "string, LKR, e.g. \"1800000\""},
    "band.progressive": {
        "bands": [{"upto": "cumulative top edge in LKR as integer, or null for the last band", "rate": "decimal string e.g. \"0.06\""}]
    },
    "deduction.epf_employee": {"employee_rate": "decimal string e.g. \"0.08\""},
    "deduction.qualifying": {"annual_cap": "LKR string, or null if uncapped"},
    "deadline.return_filing": {
        "due": "ISO date e.g. \"2027-11-30\"",
        "instalments": ["ISO dates"],
    },
    "credit.apit": {"allowed": True},
    "credit.foreign_wht": {"allowed": True},
    "income.assessable": {"includes": ["list of income types"]},
    "charge.taxable_income": {"formula": "string"},
}


class ProposedChange(BaseModel):
    rule_key: str = Field(description="One of the allowed rule keys")
    operation: Literal["create", "amend", "supersede", "no_change"]
    value_json: dict[str, Any] = Field(description="Matches the shape for this rule_key exactly")
    effective_from: str | None = Field(None, description="ISO date the rule takes effect, or null if not stated")
    effective_to: str | None = Field(None, description="ISO date it ceases, usually null")
    applies_to_ya: list[str] = Field(default_factory=list, description="e.g. [\"2026/2027\"]")
    quoted_text: str = Field(description="The exact sentence(s) from the document the value came from, verbatim")
    citation_label: str | None = Field(None, description="Short label for the citation card, e.g. \"Circular SEC/2026/04\" or \"Act s.52\"")
    confidence: float = Field(ge=0, le=1)
    rationale: str = Field(description="One or two sentences: why this is the value and why this rule key")


class Extraction(BaseModel):
    document_summary: str = Field(description="Two sentences: what this document is and what it changes")
    document_kind: Literal["circular", "gazette", "act_amendment", "apit_table", "guideline", "news", "unrelated"]
    relevant_to_personal_income_tax: bool
    published_date: str | None = Field(None, description="ISO date the document was issued, if stated")
    proposals: list[ProposedChange] = Field(default_factory=list)


SYSTEM = f"""You are the extraction step of Citetax, a Sri Lankan personal income tax corpus pipeline.

You read ONE document and propose structured rule changes for a human reviewer to approve or reject. You never decide; you propose.

RULES:
1. Only propose a change when the document STATES a value: a rate, a threshold, an amount, a date. Do not infer, do not compute, do not fill gaps from memory.
2. Quote the exact sentence the value came from. The reviewer compares your quote to your field; a paraphrase is useless to them.
3. Use only these rule keys, and match the value_json shape exactly:
{json.dumps(RULE_SHAPES, indent=2)}
4. Personal income tax for individuals only. VAT, SSCL, corporate tax, customs: mark relevant_to_personal_income_tax=false and propose nothing.
5. If a document merely restates a rule that is already law (e.g. a guide explaining existing bands), still extract it, with operation "no_change" and lower confidence. The reviewer decides whether it adds anything.
6. Dates: Sri Lankan year of assessment runs 1 April to 31 March. "Y/A 2026/27" means effective_from 2026-04-01. If a circular says "with effect from" a date, use that date.
7. Confidence: 0.9+ only when the value, the rule, and the effective date are all explicit. 0.5 to 0.8 when one is inferred from context. Below 0.5 when unsure which rule key applies.
8. Amounts are strings without commas. Rates are decimal strings (6% is "0.06").
9. If the text is a navigation page, a news listing, or unrelated, return document_kind accordingly with no proposals."""


@dataclass
class ExtractReport:
    document_id: str
    proposals_created: int = 0
    proposals_updated: int = 0
    relevant: bool | None = None
    summary: str | None = None
    llm: dict[str, Any] | None = None
    error: str | None = None
    skipped_reason: str | None = None

    def to_json(self) -> dict[str, Any]:
        return self.__dict__.copy()


def _parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def _earliest_supported_start() -> date:
    from app.core.config import get_settings
    from app.rules.resolver import ya_start_date

    return min(ya_start_date(ya) for ya in get_settings().supported_yas)


def _why_not(conn: Connection, document_id: str, p: ProposedChange, value_json: dict[str, Any]) -> str | None:
    """A reason to drop an extracted change before a reviewer sees it, or None.

    Reviewers were seeing the same figure once per page it appeared on, the
    figure already published, and figures from years Citetax does not cover.
    None of those is a decision.
    """
    start = _earliest_supported_start()
    ef, et = _parse_date(p.effective_from), _parse_date(p.effective_to)
    from app.core.config import get_settings

    supported = set(get_settings().supported_yas)
    names_supported = any(ya in supported for ya in p.applies_to_ya)
    if (et and et < start) or (ef and ef < start and not names_supported):
        return "before the supported years"
    due = _parse_date(str(value_json.get("due") or "")) if p.rule_key.startswith("deadline.") else None
    if due and due < start:
        return "before the supported years"

    v = json.dumps({k: val for k, val in value_json.items() if k != "citation_label"})
    same_value = (
        "(x.value_json - 'citation_label') = cast(:v as jsonb) "
        "and x.rule_key = :k and x.effective_from is not distinct from :ef"
    )
    params = {"v": v, "k": p.rule_key, "ef": ef, "d": document_id}
    if conn.execute(
        text(f"select 1 from rule_version x where x.status = 'published' and {same_value} limit 1"),
        params,
    ).first():
        return "already published"
    # The same value as the version already in force on that date restates
    # the law rather than changing it, whatever start date the page gives.
    if ef and conn.execute(
        text(
            "select 1 from rule_version x "
            "  join snapshot_rule_version s on s.rule_version_id = x.id "
            "  join corpus_snapshot c on c.id = s.snapshot_id and c.is_current "
            " where x.rule_key = :k and x.status = 'published' "
            "   and (x.value_json - 'citation_label') = cast(:v as jsonb) "
            "   and x.effective_from <= :ef and (x.effective_to is null or x.effective_to >= :ef) "
            " limit 1"
        ),
        params,
    ).first():
        return "already in force"
    if conn.execute(
        text(
            f"select 1 from change_proposal x where {same_value} "
            "and x.status in ('needs_review','in_review','changes_requested','approved') limit 1"
        ),
        params,
    ).first():
        return "already proposed"
    return None


def extract_document(
    conn: Connection,
    document_id: str,
    budget: llm.LLMBudget | None = None,
    replace_placeholder: bool = True,
) -> ExtractReport:
    """Run the extractor on one document and write proposals.

    If the watcher already created a placeholder proposal (no rule_key), it is
    updated in place for the first extracted change and additional changes get
    their own rows, so the inbox never shows a blank row next to a filled one
    for the same document.
    """
    report = ExtractReport(document_id=document_id)

    row = conn.execute(
        text(
            "select id, title, url, raw_text, doc_type, revision_no, supersedes_id, "
            "       coalesce((text_meta->>'link_share')::float, 0) as link_share, "
            "       coalesce((text_meta->>'listing')::boolean, false) as listing "
            "  from source_document where id = :id"
        ),
        {"id": document_id},
    ).mappings().first()
    if not row:
        report.error = "document not found"
        return report
    if not row["raw_text"] or len(row["raw_text"].strip()) < 80:
        report.skipped_reason = "no extractable text"
        return report
    if row["listing"] or row["link_share"] >= LISTING_LINK_SHARE:
        report.skipped_reason = "listing page"
        _resolve_placeholder(
            conn, document_id,
            "A listing page: it links to documents rather than stating a rule.",
            {"listing": True, "extractor_version": EXTRACTOR_VERSION},
        )
        conn.commit()
        return report
    if not llm.available():
        report.skipped_reason = "model unavailable"
        return report

    body = row["raw_text"][:24000]
    user = (
        f"DOCUMENT TITLE: {row['title'] or 'untitled'}\n"
        f"SOURCE URL: {row['url'] or 'uploaded'}\n"
        f"REVISION: {row['revision_no']}"
        + (" (this is a revision of a document already in the corpus; look for what changed)" if row["supersedes_id"] else "")
        + f"\n\nDOCUMENT TEXT:\n{body}"
    )

    try:
        extraction, call = llm.structured(
            Extraction, SYSTEM, user, max_tokens=4000, budget=budget
        )
    except llm.LLMUnavailable as exc:
        report.error = str(exc)[:200]
        conn.execute(
            text(
                "update change_proposal set status = 'extraction_failed', "
                "quoted_text = coalesce(quoted_text, '') || ' | extractor: ' || :e "
                " where source_document_id = :d and rule_key is null"
            ),
            {"e": str(exc)[:200], "d": document_id},
        )
        conn.commit()
        return report

    report.llm = call.to_json()
    report.relevant = extraction.relevant_to_personal_income_tax
    report.summary = extraction.document_summary

    # Record what the document is, and its stated date, on the document row.
    # Merged, so the watcher's fingerprint survives.
    conn.execute(
        text(
            "update source_document set "
            "text_meta = coalesce(text_meta, '{}'::jsonb) || cast(:m as jsonb), "
            "published_at = coalesce(published_at, :pub) where id = :id"
        ),
        {
            "m": json.dumps({
                "summary": extraction.document_summary,
                "kind": extraction.document_kind,
                "relevant": extraction.relevant_to_personal_income_tax,
                "extractor_version": EXTRACTOR_VERSION,
            }),
            "pub": _parse_date(extraction.published_date),
            "id": document_id,
        },
    )

    placeholder = conn.execute(
        text(
            "select id, priority from change_proposal "
            " where source_document_id = :d and rule_key is null "
            " order by created_at limit 1"
        ),
        {"d": document_id},
    ).mappings().first()

    if not extraction.relevant_to_personal_income_tax or not extraction.proposals:
        # Nothing to propose. Resolve the placeholder so the inbox is honest
        # rather than leaving a blank row waiting forever.
        if placeholder:
            conn.execute(
                text(
                    "update change_proposal set status = 'rejected', "
                    "reviewed_by = 'extractor', reviewed_at = now(), "
                    "reject_reason = :r, extractor_version = :v, "
                    "rationale = :s where id = :id"
                ),
                {
                    "r": "Extractor found no personal income tax rule in this document."
                    if extraction.relevant_to_personal_income_tax
                    else f"Not personal income tax ({extraction.document_kind}).",
                    "v": EXTRACTOR_VERSION,
                    "s": extraction.document_summary,
                    "id": placeholder["id"],
                },
            )
        conn.commit()
        return report

    # Priority: a revision of something published stays P1. Otherwise value
    # bearing changes are P2, deadlines P3, editorial P5.
    base_priority = placeholder["priority"] if placeholder else 4

    def priority_for(p: ProposedChange) -> int:
        if base_priority == 1:
            return 1
        if p.rule_key.startswith(("band.", "relief.", "deduction.", "credit.")):
            return 2
        if p.rule_key.startswith("deadline."):
            return 3
        if p.operation == "no_change":
            return 5
        return 4

    first = True
    dropped: list[str] = []
    for p in extraction.proposals:
        if p.rule_key not in RULE_SHAPES:
            continue
        cite = p.citation_label
        value_json = dict(p.value_json)
        if cite:
            value_json["citation_label"] = cite
        reason = _why_not(conn, document_id, p, value_json)
        if reason:
            dropped.append(f"{p.rule_key} {reason}")
            continue

        params = {
            "key": p.rule_key,
            "op": p.operation,
            "v": json.dumps(value_json),
            "ef": _parse_date(p.effective_from),
            "et": _parse_date(p.effective_to),
            "ya": p.applies_to_ya or None,
            "q": p.quoted_text[:4000],
            "conf": round(max(0.0, min(1.0, p.confidence)), 2),
            "ver": EXTRACTOR_VERSION,
            "pri": priority_for(p),
            "rat": p.rationale[:2000],
            "ext": json.dumps(p.model_dump()),
        }

        if first and placeholder and replace_placeholder:
            conn.execute(
                text(
                    "update change_proposal set rule_key = :key, operation = :op, "
                    "value_json = cast(:v as jsonb), effective_from = :ef, "
                    "effective_to = :et, applies_to_ya = :ya, quoted_text = :q, "
                    "confidence = :conf, extractor_version = :ver, priority = :pri, "
                    "rationale = :rat, extraction_json = cast(:ext as jsonb), "
                    "status = 'needs_review' where id = :id"
                ),
                {**params, "id": placeholder["id"]},
            )
            report.proposals_updated += 1
        else:
            conn.execute(
                text(
                    "insert into change_proposal (id, source_document_id, rule_key, "
                    "operation, value_json, effective_from, effective_to, "
                    "applies_to_ya, quoted_text, confidence, extractor_version, "
                    "status, priority, rationale, extraction_json) values "
                    "(:id, :d, :key, :op, cast(:v as jsonb), :ef, :et, :ya, :q, "
                    ":conf, :ver, 'needs_review', :pri, :rat, cast(:ext as jsonb))"
                ),
                {**params, "id": str(uuid.uuid4()), "d": document_id},
            )
            report.proposals_created += 1
        first = False

    if first and placeholder:
        # Everything it found was a duplicate, already live, or out of range.
        report.skipped_reason = "; ".join(dropped)[:300] or "no usable change"
        _resolve_placeholder(conn, document_id, f"Nothing new: {report.skipped_reason}.", None)

    conn.commit()
    return report


def _resolve_placeholder(conn: Connection, document_id: str, reason: str, meta: dict | None) -> None:
    conn.execute(
        text(
            "update change_proposal set status = 'rejected', reviewed_by = 'extractor', "
            "reviewed_at = now(), reject_reason = :r, extractor_version = :v "
            "where source_document_id = :d and rule_key is null and status = 'needs_review'"
        ),
        {"r": reason, "v": EXTRACTOR_VERSION, "d": document_id},
    )
    if meta:
        conn.execute(
            text(
                "update source_document set "
                "text_meta = coalesce(text_meta, '{}'::jsonb) || cast(:m as jsonb) where id = :d"
            ),
            {"m": json.dumps(meta), "d": document_id},
        )


def extract_pending(conn: Connection, limit: int = 5, budget: llm.LLMBudget | None = None) -> list[ExtractReport]:
    """Documents with a placeholder proposal and text, not yet extracted."""
    # Highest priority first: a silent revision of a published rule (P1) is
    # extracted before a new guideline page, because a live rule may be wrong.
    # Postgres requires ORDER BY columns to appear in a DISTINCT select list,
    # so the join is folded into a subquery that also yields the priority.
    ids = conn.execute(
        text(
            "select d.id from source_document d "
            "  join (select source_document_id, min(priority) as pri "
            "          from change_proposal "
            "         where rule_key is null and status = 'needs_review' "
            "         group by source_document_id) p "
            "    on p.source_document_id = d.id "
            " where d.raw_text is not null and length(d.raw_text) > 80 "
            "   and (d.text_meta is null or d.text_meta->>'extractor_version' is null) "
            " order by p.pri asc, d.fetched_at desc limit :n"
        ),
        {"n": limit},
    ).scalars().all()
    out = []
    for doc_id in ids:
        try:
            out.append(extract_document(conn, str(doc_id), budget))
        except Exception as exc:  # noqa: BLE001
            conn.rollback()
            r = ExtractReport(document_id=str(doc_id), error=str(exc)[:200])
            out.append(r)
            logger.warning("extract failed for %s: %s", doc_id, exc)
    return out
