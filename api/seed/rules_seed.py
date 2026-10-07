"""Seed the rules corpus for both supported years of assessment.

VALUES SOURCED FROM REAL LAW — Inland Revenue (Amendment) Act No. 2 of 2025,
effective 1 April 2025 (YA 2025/2026 onwards).

  Bands (resident individuals):
      first  1,000,000  @  6%
      next     500,000  @ 18%   (to 1,500,000)
      next     500,000  @ 24%   (to 2,000,000)
      next     500,000  @ 30%   (to 2,500,000)
      above  2,500,000  @ 36%
  Personal relief: Rs. 1,800,000 per YA commencing on or after 1 April 2025
                   (confirmed on ird.gov.lk)
  Return deadline: on or before 30 November of the next succeeding YA
                   (confirmed on ird.gov.lk)
  Quarterly instalments: 15 Aug, 15 Nov, 15 Feb, 15 May

No rate change has been announced for 2026/2027, so the same table carries
forward — modelled here as one rule_version with an open-ended effective_to,
which is exactly what resolve() is designed to handle.

⚠️  STILL NOT REVIEWER-SIGNED (spec §1.1 property 3, Appendix B item 5).
These figures come from published secondary sources and the IRD website, not
from a reviewer who has signed them off against the gazetted text. Every row
is stamped with the changelog_line below so the provenance never overclaims.
Phase 3 (admin panel) is where these get properly reviewed and approved.

Safe to re-run. The seed only loads an empty corpus: once any snapshot exists
it changes nothing, so it can never delete saved answers, conversations, or
rule versions published through the admin panel. Later rule changes go
through the admin review and publish flow, not through this script.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import date

from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core.config import get_settings  # noqa: E402

SEED_NOTE = (
    "SEED — sourced from Inland Revenue (Amendment) Act No. 2 of 2025 via "
    "ird.gov.lk and taxadvisor.lk; NOT yet reviewer-signed"
)

# --- Rule catalogue --------------------------------------------------------
RULES = [
    ("income.assessable",     "Assessable income",              "amount",     "LKR",     "half_up"),
    ("deduction.epf_employee","EPF employee contribution",      "rate",       "percent", "half_up"),
    ("deduction.qualifying",  "Qualifying payments",            "amount",     "LKR",     "half_up"),
    ("deduction.business_expenses", "Business expenses",        "amount",     "LKR",     "half_up"),
    ("band.foreign_service_cap", "Foreign-currency service income rate cap", "rate", "percent", "half_up"),
    ("relief.personal",       "Personal relief",                "amount",     "LKR",     "half_up"),
    ("charge.taxable_income", "Taxable income",                 "amount",     "LKR",     "half_up"),
    ("band.progressive",      "Progressive tax bands",          "rate_table", "percent", "half_up"),
    ("credit.foreign_wht",    "Foreign tax and WHT credits",    "amount",     "LKR",     "half_up"),
    ("credit.apit",           "APIT credit",                    "amount",     "LKR",     "half_up"),
    ("deadline.return_filing","Return filing deadline",         "date",       "date",    "half_up"),
    ("filing.apit_exemption", "No return for APIT-only employees", "flag",     "boolean", "half_up"),
]

# --- Band table ------------------------------------------------------------
# Inland Revenue (Amendment) Act No. 2 of 2025, effective 1 April 2025.
# `upto` is the cumulative top edge of the band; None means "and above".
# Unchanged for 2026/2027 — no rate amendment announced.
BANDS_ACT_2_OF_2025 = [
    {"upto": 1000000, "rate": "0.06"},
    {"upto": 1500000, "rate": "0.18"},
    {"upto": 2000000, "rate": "0.24"},
    {"upto": 2500000, "rate": "0.30"},
    {"upto": None,    "rate": "0.36"},
]

PERSONAL_RELIEF = "1800000"   # Rs. 1,800,000, YAs commencing on/after 1 Apr 2025

# Rules whose text is identical for both supported years get ONE rule_version
# with an open-ended effective window, because that is what the law actually
# says. resolve() picks it for either YA. Duplicating a row per year would be
# inventing an amendment that never happened.
#
# (rule_key, value_json, citation_label, quoted_text)
SHARED_VERSIONS: list[tuple] = [
    ("income.assessable",
     {"includes": ["employment", "business", "investment", "other"]},
     "Act s.5",
     "The assessable income of a person for a year of assessment from employment, "
     "business, investment or other sources."),

    # The employee's 8% EPF contribution is not deductible: the Inland Revenue
    # Act allows no deduction in calculating employment income, and the Fifth
    # Schedule lists no relief for it (#47). The rate is kept because the ledger
    # shows the contribution, cited, at zero.
    ("deduction.epf_employee",
     {"employee_rate": "0.08", "deductible": False},
     "Act s.10(1)(a)",
     "No deduction shall be made in calculating a person's income from employment."),

    # Freelance and business income is taxed after the expenses of earning it
    # (#48). Capital items are excluded by s.11(2).
    ("deduction.business_expenses",
     {"capital_excluded": True},
     "Act s.11(1)",
     "In calculating a person\u2019s income from a business or investment for a year of "
     "assessment, expenses to the extent they are incurred during the year by the person "
     "and in the production of income from the business or investment, shall be deducted."),

    # Services for clients abroad, paid in foreign currency through a bank: the
    # ordinary bands, at most 15% (#48). The IRD return guide for 2025/2026
    # (illustrations 2 and 3) shows how it is applied.
    ("band.foreign_service_cap",
     {"max_rate": "0.15"},
     "First Schedule para 1(6)",
     "an individual\u2019s following gains and profits shall be taxed at the maximum rate "
     "of 15% with effect from April 1, 2025: (a) the gains and profits earned or derived "
     "from any service rendered in or outside Sri Lanka to any person to be utilized "
     "outside Sri Lanka, where the payment for such services is received in foreign "
     "currency and remitted through a bank to Sri Lanka"),

    ("deduction.qualifying",
     {"annual_cap": None},
     "Act s.52",
     "Qualifying payments and reliefs to which a person is entitled for a year "
     "of assessment."),

    ("relief.personal",
     {"amount": PERSONAL_RELIEF},
     "Act s.52 (Amd. No. 2 of 2025)",
     "Rs. 1,800,000, for each year of assessment commencing on or after "
     "April 1, 2025."),

    ("charge.taxable_income",
     {"formula": "assessable - deductions - relief"},
     "Act s.3",
     "The taxable income of a person for a year of assessment shall be the "
     "assessable income less qualifying payments and reliefs."),

    ("band.progressive",
     {"bands": BANDS_ACT_2_OF_2025},
     "Amendment No. 2 of 2025",
     "The first Rs. 1,000,000 at 6%, the next Rs. 500,000 at 18%, the next "
     "Rs. 500,000 at 24%, the next Rs. 500,000 at 30%, and the balance at 36%."),

    ("credit.foreign_wht",
     {"allowed": True},
     "Act s.80",
     "A credit shall be granted for foreign income tax paid and tax withheld."),

    # No return, and no instalments, for an employee whose only tax is on
    # employment income and was deducted as APIT. Paragraph (d), for interest
    # of up to Rs 5,000, was added by Act No. 11 of 2026 with effect from
    # 1 April 2025.
    ("filing.apit_exemption",
     {"interest_limit": "5000"},
     "Act s.94(1)(c), (d)",
     "(c) an individual whose tax payable for the year of assessment under paragraph (a) "
     "of subsection (1) of section 2 relates exclusively to income from employment where "
     "the employer has deducted Advance Personal Income Tax under section 83A and no tax "
     "shall be payable under paragraph (b) or (c) of subsection (2) of section 82; or (d) "
     "an individual referred to in paragraph (c) of this subsection, whose interest income "
     "for the year of assessment does not exceed five thousand rupees."),

    ("credit.apit",
     {"allowed": True},
     "APIT scheme",
     "Tax deducted under the Advance Personal Income Tax scheme shall be "
     "credited against the tax payable."),
]

# Deadlines genuinely differ per year, so these are per-YA rule versions.
DEADLINE_VERSIONS: dict[str, tuple] = {
    "2025/2026": (
        {"due": "2026-11-30",
         "instalments": ["2025-08-15", "2025-11-15", "2026-02-15", "2026-05-15"]},
        "Act s.93",
        "A return shall be furnished on or before the thirtieth day of the month "
        "of November of the next succeeding year of assessment.",
    ),
    "2026/2027": (
        {"due": "2027-11-30",
         "instalments": ["2026-08-15", "2026-11-15", "2027-02-15", "2027-05-15"]},
        "Act s.93",
        "A return shall be furnished on or before the thirtieth day of the month "
        "of November of the next succeeding year of assessment.",
    ),
}

# The Amendment took effect 1 April 2025 and has not been superseded, so the
# shared rules are open-ended.
ACT_EFFECTIVE_FROM = date(2025, 4, 1)

YA_WINDOWS = {
    "2025/2026": (date(2025, 4, 1), date(2026, 3, 31)),
    "2026/2027": (date(2026, 4, 1), date(2027, 3, 31)),
}


SNAPSHOT_LABEL = "18 August 2026"


def seed(conn) -> dict:
    """Load the seed corpus into an empty database. Never deletes anything.

    The database is shared, and saved answers are the audit record that makes
    each one reproducible at its snapshot, so an existing corpus is left
    exactly as it is. Returns what was seeded, or the snapshot already current.
    """
    # Two teammates seeding an empty database at once would both see it empty.
    # The lock is released when the transaction ends.
    conn.execute(text("select pg_advisory_xact_lock(hashtext('citetax.rules_seed'))"))

    if conn.execute(text("select count(*) from corpus_snapshot")).scalar_one():
        current = conn.execute(
            text(
                "select s.label, count(srv.rule_version_id) as versions "
                "  from corpus_snapshot s "
                "  left join snapshot_rule_version srv on srv.snapshot_id = s.id "
                " where s.is_current group by s.id, s.label"
            )
        ).mappings().first()
        return {
            "seeded": False,
            "label": current["label"] if current else None,
            "versions": current["versions"] if current else 0,
        }

    # --- rule catalogue ---
    for key, title, rtype, unit, rounding in RULES:
        conn.execute(
            text(
                "insert into rule (rule_key, title, rule_type, unit, rounding_mode) "
                "values (:k, :t, :rt, :u, :rm) on conflict (rule_key) do update "
                "set title = excluded.title"
            ),
            {"k": key, "t": title, "rt": rtype, "u": unit, "rm": rounding},
        )

    # --- a source document to hang provenance on ---
    doc_id = str(uuid.uuid4())
    conn.execute(
        text(
            "insert into source_document (id, family_id, revision_no, source_id, "
            "sha256, doc_type, title, published_at) values "
            "(:id, :fam, 1, 'seed', :sha, 'act_amendment', :title, :pub) "
            "on conflict do nothing"
        ),
        {
            "id": doc_id,
            "fam": str(uuid.uuid4()),
            "sha": "seed-" + doc_id[:12],
            "title": "Inland Revenue Act (seed placeholder)",
            "pub": date(2026, 4, 1),
        },
    )

    # --- rule versions ---
    insert_rv = text(
        "insert into rule_version (id, rule_key, revision_no, value_json, "
        "effective_from, effective_to, source_document_id, citation_label, "
        "quoted_text, status, changelog_line, approved_by, approved_at) "
        "values (:id, :k, 1, cast(:v as jsonb), :ef, :et, :doc, :cite, "
        ":q, 'published', :note, 'seed-script', now())"
    )
    version_ids: list[str] = []

    # Shared rules: one open-ended version covering both supported years.
    for rule_key, value_json, citation, quoted in SHARED_VERSIONS:
        vid = str(uuid.uuid4())
        conn.execute(
            insert_rv,
            {
                "id": vid,
                "k": rule_key,
                "v": json.dumps(value_json),
                "ef": ACT_EFFECTIVE_FROM,
                "et": None,
                "doc": doc_id,
                "cite": citation,
                "q": quoted,
                "note": SEED_NOTE,
            },
        )
        version_ids.append(vid)

    # Deadlines: one version per year of assessment.
    for ya, (value_json, citation, quoted) in DEADLINE_VERSIONS.items():
        eff_from, eff_to = YA_WINDOWS[ya]
        vid = str(uuid.uuid4())
        conn.execute(
            insert_rv,
            {
                "id": vid,
                "k": "deadline.return_filing",
                "v": json.dumps(value_json),
                "ef": eff_from,
                "et": eff_to,
                "doc": doc_id,
                "cite": citation,
                "q": quoted,
                "note": SEED_NOTE,
            },
        )
        version_ids.append(vid)

    # --- snapshot --- (the corpus is empty, so this is the only one)
    snap_id = str(uuid.uuid4())
    conn.execute(
        text(
            "insert into corpus_snapshot (id, label, created_by, is_current, changelog) "
            "values (:id, :label, 'seed-script', true, :log)"
        ),
        {
            "id": snap_id,
            "label": SNAPSHOT_LABEL,
            "log": "Initial seed corpus. " + SEED_NOTE,
        },
    )
    for vid in version_ids:
        conn.execute(
            text(
                "insert into snapshot_rule_version (snapshot_id, rule_version_id) "
                "values (:s, :v) on conflict do nothing"
            ),
            {"s": snap_id, "v": vid},
        )

    return {
        "seeded": True,
        "snapshot_id": snap_id,
        "label": SNAPSHOT_LABEL,
        "versions": len(version_ids),
    }


def main() -> None:
    settings = get_settings()
    if not settings.database_url:
        raise SystemExit("DATABASE_URL is not set — copy .env.example to .env first")

    engine = create_engine(settings.database_url)
    with engine.begin() as conn:
        result = seed(conn)

    if not result["seeded"]:
        print(
            f"Corpus already seeded: current snapshot '{result['label']}' "
            f"({result['versions']} rule versions). Nothing changed."
        )
        print("Publish rule changes through the admin panel, not this script.")
        return

    print(
        f"Seeded {result['versions']} rule versions "
        f"({len(SHARED_VERSIONS)} shared across both years, "
        f"{len(DEADLINE_VERSIONS)} year-specific)."
    )
    print(f"Current snapshot: {result['snapshot_id']}  (label: {SNAPSHOT_LABEL})")
    print(f"\n⚠️  {SEED_NOTE}")


if __name__ == "__main__":
    main()
