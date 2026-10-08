"""Write the demo clip's ledger from the real engine, at the current snapshot.

The video must not carry a figure the app would not give. So its ledger is
computed here exactly as the chat computes it: the rules in force for the year
at the current corpus snapshot, the same engine, and an APIT left unstated so
the employer's deduction is assumed as it is in the chat. Re-run this and
re-render whenever the law changes.

    cd video && npm run data
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal
from pathlib import Path

API = Path(__file__).resolve().parents[2] / "api"
sys.path.insert(0, str(API))

from app.compute.engine import OPTIONAL_RULE_KEYS, REQUIRED_RULE_KEYS, compute  # noqa: E402
from app.compute.types import TaxFacts  # noqa: E402
from app.db.session import db_conn  # noqa: E402
from app.graph import comply  # noqa: E402
from app.rules.resolver import current_snapshot, resolve_many  # noqa: E402

YA = "2026/2027"
# A doctor with a hospital salary and private channelling fees: a scenario of
# its own, not one used elsewhere on the site.
QUESTION = ("Hospital salary of LKR 350,000 a month, plus LKR 2,400,000 a year from private "
            "channelling. What do I owe for 2026/2027?")
FACTS = TaxFacts(ya=YA, employment_income=Decimal("4200000"), business_income=Decimal("2400000"))

OUT = Path(__file__).resolve().parents[1] / "src" / "ledger.json"


def main() -> None:
    with db_conn() as conn:
        snap = current_snapshot(conn)
        rules = resolve_many(conn, REQUIRED_RULE_KEYS + ["deadline.return_filing"], YA, str(snap["id"]),
                             optional=OPTIONAL_RULE_KEYS)
    c = compute(FACTS, rules)
    cp = comply.assess(c, rules)
    data = {
        "question": QUESTION,
        "ya": YA,
        "snapshot": snap["label"],
        "steps": [
            {"no": s.step_no, "label": s.label, "value": str(s.value), "cite": s.citation_label,
             "zero": s.is_zero, "assumed": bool((s.detail or {}).get("assumed"))}
            for s in c.steps
        ],
        "gross_tax": str(c.gross_tax),
        "balance": str(c.balance_payable),
        "must_file": cp.must_file,
        "return_due": cp.return_due,
    }
    OUT.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"wrote {OUT.name}: balance {c.balance_payable}, {len(c.steps)} steps, snapshot {snap['label']}")


if __name__ == "__main__":
    main()
