# Citetax

**Sri Lanka personal income tax copilot. Every number, cited.**

SLIIT IT3041, Information Retrieval and Web Analytics.

Citetax answers personal income tax questions for two years of assessment with
a figure, a step by step computation, and a citation to the specific version of
the rule that produced each number.

The differentiator is not that it uses agents. It is that it runs on a
maintained, versioned, human approved corpus of tax law, and a general chatbot
does not.

---

## What works today

| | |
|---|---|
| Compute engine | Pure Python, `Decimal`, 8 step ledger, every step citing a rule version. No network, no model. |
| Rule resolution | Deterministic, by year of assessment and by date, so a mid year circular applies from its effective date. Refuses rather than guessing. |
| Answer graph | 9 nodes: intake, scope gate, clarify, resolve, compute, comply, retrieve, explain, verify. |
| Verify node | Every figure in generated prose is checked against the ledger. Uncited numbers are blocked and the prose withheld. |
| Privacy layer | Coded redaction plus spaCy NER. Identifiers stripped, money preserved. |
| Admin panel | Review inbox, document viewer, diff, impact preview, dual control, publish, rollback, corpus health, audit log. |
| Source watcher | Live against taxadvisor.lk. Detects silent revisions by content hash and files them as priority 1. |
| Auth | Google sign in via NextAuth, roles held in the database. |

**109 backend tests passing.**

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
api/     FastAPI. Compute engine, resolver, answer graph, privacy layer, admin API.
web/     Next.js. User interface and admin panel.
db/      SQL migrations, applied in order by api/migrate.py.
UI/      Claude Design export, the source of truth for the interface.
```

---

## Running it

See [SETUP.md](SETUP.md) for keys and first time setup.

```powershell
cd api
.venv\Scripts\python.exe preflight.py          # checks every external service
.venv\Scripts\python.exe migrate.py            # applies db/migrations
.venv\Scripts\python.exe seed\rules_seed.py    # loads the tax rules
.venv\Scripts\python.exe -m uvicorn app.main:app --reload

cd web && npm run dev
```

| Where | What |
|---|---|
| http://localhost:3000 | Ask a question |
| http://localhost:3000/admin | Review inbox, needs the reviewer role |
| http://127.0.0.1:8000/docs | API reference |

---

## Known gaps

- **PDF text extraction is not wired.** Uploaded PDFs get lineage and audit,
  but the reviewer works from the source link rather than rendered text.
- **The extractor is a stub.** The watcher creates proposals; it does not yet
  read values out of documents, so a reviewer enters the rule key and value.
- **The IRD source is registered but disabled.** Its site builds the document
  list client side, so a plain crawler finds nothing. Recorded with the reason
  rather than left to fail silently.
- **Retrieval is deferred.** Explanations use the quoted text on each resolved
  rule version. Embeddings are configured but chunking is not built.
