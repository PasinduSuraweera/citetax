# Citetax

**Sri Lanka personal income tax copilot. Every number, cited.**

SLIIT IT3041, Information Retrieval and Web Analytics.

Citetax answers personal income tax questions for two years of assessment with a
figure, a step by step computation, and a citation to the specific version of
the rule that produced each number.

The differentiator is not that it uses agents. It is that it runs on a
maintained, versioned, human approved corpus of tax law, kept current by an
agent that watches the sources, and a general chatbot does not.

---

## How an answer is produced

The model reads the question first and picks a plan. A deadline question does
not run the computation; a rule lookup goes to retrieval; a comparison diffs the
two years. Two things never change with the path: numbers come from the rules
table and the compute engine, never from the model, and every figure in the
prose is checked against the material before release.

| Intent | Nodes |
|---|---|
| compute | Intake, Route, Resolve, Compute, Comply, Retrieve, Explain, Verify |
| obligation | Intake, Route, Resolve, Compute, Comply, Explain, Verify |
| deadline | Intake, Route, Resolve, Retrieve, Explain, Verify |
| compare | Intake, Route, Resolve, Compare, Retrieve, Explain, Verify |
| rule_lookup | Intake, Route, Resolve, Retrieve, Explain, Verify |
| general | Intake, Route, Retrieve, Resolve, Explain, Verify |
| out_of_scope | Intake, Route, refuse with a reason and a pointer |

**Intake** strips identifiers in process before anything leaves the machine.
**Route** is one structured model call: intent, scope, facts in annual LKR, and
one clarifying question if a required fact is missing. A deterministic regex
route is the fallback and a cross check: its refusals always stand.
**Resolve** picks the rule version in force for the year and the date, and
refuses rather than guessing. **Verify** traces every number, percentage and
date in the prose to the ledger, a rule value, or a retrieved passage.

## The corpus agent

Runs on a timer inside the API. Each cycle it crawls every enabled source,
detects silent revisions by content hash, extracts text from PDFs and pages,
asks the model to pre-fill proposals with the rule key, value, effective date,
quoted sentence, confidence and rationale, and indexes new passages for
retrieval. It stops at the point a human has to decide: it never approves, never
publishes, never touches a published rule.

Reviewers see the agent's report on the admin panel, take pre-filled proposals
from the inbox, run an impact preview across the golden set, and sign. Anything
that changes a computed figure needs two distinct people.

---

## Tax figures in use

Inland Revenue (Amendment) Act No. 2 of 2025, effective 1 April 2025 and
unchanged for 2026/2027. Sourced from ird.gov.lk and taxadvisor.lk.

| Taxable income | Rate |
|---|---|
| First 1,000,000 | 6% |
| Next 500,000 | 18% |
| Next 500,000 | 24% |
| Next 500,000 | 30% |
| Above 2,500,000 | 36% |

Personal relief 1,800,000. Return due 30 November of the next year of
assessment. Instalments 15 Aug, 15 Nov, 15 Feb, 15 May.

> These are seeded from published sources and are **not yet reviewer signed**.
> Every seeded rule version says so in its changelog line. Signing them off is
> what the admin panel exists for.

---

## Layout

```
api/     FastAPI. Planner graph, compute engine, resolver, privacy layer,
         retrieval, extractor, corpus agent, admin API.
web/     Next.js. User interface, Google sign in, admin panel.
db/      SQL migrations, applied in order by api/migrate.py.
UI/      Claude Design export, the source of truth for the interface.
```

## Running it

See [SETUP.md](SETUP.md) for keys and first time setup.

```powershell
cd api
.venv\Scripts\python.exe preflight.py          # checks every external service
.venv\Scripts\python.exe migrate.py            # applies db/migrations
.venv\Scripts\python.exe seed\rules_seed.py    # loads the tax rules into an empty database
.venv\Scripts\python.exe -m uvicorn app.main:app --reload

cd web && npm run dev
```

| Where | What |
|---|---|
| http://localhost:3000 | Ask a question |
| http://localhost:3000/admin | Review inbox, needs the reviewer role |
| http://localhost:3000/admin/agent | What the corpus agent has done |
| http://127.0.0.1:8000/docs | API reference |

Tests: `pytest tests/` in `api/` (132), and `smoke_test.py` runs every intent
against the live model.

---

## Known gaps

- **The IRD source is registered but disabled.** Its site builds the document
  list client side, so a plain crawler finds nothing. Documents from IRD enter by
  reviewer upload until a crawlable index is found.
- **Scanned PDFs yield no text.** pypdf reads text layers only; OCR would be a
  separate service. The extractor reports "no extractable text" rather than
  guessing.
- **Embedding quota.** The free Gemini tier rate limits per minute. Passages that
  miss an embedding are still searchable by full text, and the agent retries
  next cycle.
- **The reranker is fusion, not a cross encoder.** The spec's BGE reranker needs
  model weights this build does not load; reciprocal rank fusion of full text and
  dense results stands in, capped at 20 candidates.
