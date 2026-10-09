# Citetax -System Specification

**Sri Lanka Personal Income Tax Copilot**
*Every number, cited.*

| | |
|---|---|
| Module | SLIIT IT3041 -Information Retrieval and Web Analytics |
| Version | 1.1 -post-mid-evaluation rebuild, revised for hardware constraints |
| Date | 26 August 2026 |
| Status | Design frozen for build; agent layer and build order are a clean redesign |
| Target platform | Google Cloud, serverless (Cloud Run) |

---

## 1. Product definition

Citetax answers Sri Lankan **personal income tax** questions for **two years of assessment** with a figure, a step-by-step computation, and a citation to the specific version of the rule that produced each number.

### 1.1 The thesis

The differentiator is not that Citetax uses agents. It is that **Citetax runs on a maintained, versioned, human-approved corpus of tax law**, and a general chatbot does not.

The failure it exists to prevent, taken from the real August 2026 case: one IRD circular was issued on 6 August, revised, and revised again on 12 August. A general assistant cites whichever copy it happened to index, undated, with full confidence. Citetax resolves the same question to *the revision in force for the year of assessment being asked about*, shows the effective dates, and shows which earlier revision it supersedes.

Three properties follow from this, and everything in the system serves them:

1. **Currency** -new IRD circulars, gazettes and amendments are detected within a day and enter a review pipeline.
2. **Provenance** -every figure released to a user traces to a `rule_version` row with an effective window and a source document anchor.
3. **Human authority** -no machine-extracted rule reaches a user until a qualified reviewer approves it. This is the admin panel, and it is a first-class part of the product, not internal tooling.

### 1.2 Scope

| In scope | Out of scope -refused with a reason |
|---|---|
| Personal income tax (employment, business, investment, other income for individuals) | VAT, SSCL, corporate income tax, PAYE for employers as filers |
| Years of assessment 2025/2026 and 2026/2027 | Any other year of assessment |
| APIT credit, EPF/ETF employee treatment, personal relief, band computation | Tax planning, structuring, or "what should I do" advice |
| Filing obligation, deadlines, instalment dates, penalty exposure | Representation before IRD, appeals, disputes |
| Comparison of the two supported years, and the amendment that caused the change | Legal opinion |

Refusal is a designed output with a reason and, where possible, a pointer to the right IRD resource. It is not an error state.

### 1.3 Users

| Role | Who | What they need |
|---|---|---|
| **Anonymous / Free** | Anyone checking whether they must file | Obligation check, one estimate per year of assessment, deadline reminders |
| **Individual** | Salaried filers, freelancers, mixed income | Unlimited computations, payslip upload, year-on-year comparison, full computation export |
| **Practice** | Small accounting practices | Multi-client workspace, bulk checking, branded exports, full audit trail |
| **Reviewer** | Tax professional (internal or contracted) | Review and approve extracted rule changes before publication |
| **Approver** | Senior reviewer | Second signature on rate, band and threshold changes |
| **Admin** | Team | Source registry, user/org management, rollback |
| **Auditor** | Read-only | Immutable audit log, corpus history |

---

## 2. Architecture

### 2.1 Stack

Same technology choices as the mid-evaluation. What changed is *where things run* -see §2.4 -and that the privacy layer is coded rather than model-based.

| Layer | Technology |
|---|---|
| Interface | Next.js (App Router), TypeScript, Tailwind |
| Services | FastAPI, LangGraph orchestration, HTTP between services, MCP tools |
| Models | Groq `gpt-oss-120b` (language, hosted). BGE-M3 (embeddings) and BGE reranker, served from a **dedicated Cloud Run service**, never in-process. spaCy `en_core_web_sm` (NER, ~12 MB, in-process) |
| Privacy layer | **Coded** -deterministic pattern matching + spaCy NER + data minimisation. No local LLM (see §9.1) |
| Data | PostgreSQL 16 + `pgvector`, Postgres full-text/BM25 index, versioned rules table, Redis |
| Deployment | Google Cloud Run (containers built in CI, no local Docker Compose in the spec) |

### 2.2 Google Cloud mapping

| Component | GCP service | Notes |
|---|---|---|
| Web app | Cloud Run service `citetax-web` | Next.js standalone output, scale-to-zero |
| Answer API + orchestrator | Cloud Run service `citetax-api` | `min-instances=1` to avoid cold start on the interactive path |
| Admin API | Cloud Run service `citetax-admin` | Separate service, separate service account, fronted by IAP |
| Source watcher | Cloud Run **Job** `corpus-watcher` + Cloud Scheduler | Daily 02:00 IST, and on-demand |
| Extraction worker | Cloud Run service `corpus-extractor` (Pub/Sub push) | Scales with queue depth |
| Embedding + rerank | Cloud Run service `citetax-embed`, 4 GiB / 2 vCPU | The **only** service that loads model weights. `min-instances=0`, concurrency 4. See §2.4 |
| Indexing | Cloud Run **Job** `corpus-indexer` | Chunk + embed in batches on publish; calls `citetax-embed`, writes vectors |
| Event bus | Pub/Sub topics `source.changed`, `proposal.ready`, `corpus.published` | Decouples crawl from extraction from publish |
| Database | Cloud SQL for PostgreSQL 16, `pgvector` enabled | Private IP; Cloud Run direct VPC egress. Not scale-to-zero -accepted cost floor |
| Cache / rate limit | Memorystore for Redis (Basic, 1 GB) | Session, rate limits, resolved-rule cache keyed by `corpus_snapshot_id` |
| Raw documents | Cloud Storage bucket `citetax-corpus-raw` | Immutable, object versioning on, retention lock |
| Exports | Cloud Storage bucket `citetax-exports` | Signed URLs, 7-day lifecycle |
| Secrets | Secret Manager | Groq key, DB creds, signing keys |
| User auth | Identity Platform (Firebase Auth) | Email + Google |
| Admin auth | Identity-Aware Proxy + Google Workspace group | Admin panel is never on the public internet path |
| Traces / evals | Cloud Logging → BigQuery sink | Every agent hop logged as structured JSON |
| CI/CD | GitHub Actions → Artifact Registry → Cloud Run | Build once, promote the same digest staging → prod |
| Edge | Cloud Armor on the web and API services | Basic WAF + rate limiting |

**Cost floor note.** Cloud SQL and Memorystore do not scale to zero. If the project budget cannot carry that, the fallback is Cloud SQL with the smallest shared-core tier and dropping Memorystore in favour of in-process caching keyed by `corpus_snapshot_id` -the cache is only useful because snapshots are immutable, so a per-instance LRU is nearly as good.

### 2.3 Service boundaries

```
                    ┌──────────────────────────────────────┐
   Public users ──▶ │ citetax-web (Next.js)        512 MiB │
                    └───────────────┬──────────────────────┘
                                    │ JSON
                    ┌───────────────▼──────────────────────┐
   Groq  ◀── HTTP ──│ citetax-api                  512 MiB │
   (hosted LLM)     │  · LangGraph answer graph            │
                    │  · deterministic compute engine      │
                    │  · coded redaction module            │
                    │  · MCP tool surface        NO WEIGHTS│
                    └──┬──────────────┬─────────────┬──────┘
                       │ HTTP         │ read-only   │ read-only
          ┌────────────▼──────┐ ┌─────▼─────────┐ ┌─▼──────────────┐
          │ citetax-embed     │ │ Cloud SQL     │ │ Memorystore    │
          │ BGE-M3 + reranker │ │ (published-   │ │ (snapshot      │
          │ 4 GiB · to-zero   │ │  only views)  │ │  cache)        │
          │ ONLY SERVICE WITH │ └─────▲─────────┘ └────────────────┘
          │ MODEL WEIGHTS     │       │ write
          └────────▲──────────┘ ┌─────┴────────────────────────────┐
                   │            │ citetax-admin            512 MiB │
                   │       IAP ▶│  · review queue, diff, impact    │
                   │            │  · publish / rollback            │
                   │            └─────▲────────────────────────────┘
                   │ embed            │ proposals
          ┌────────┴──────────┐ ┌─────┴───────────┐ ┌──────────────┐
          │ corpus-indexer    │ │ corpus-extractor│◀│ corpus-watcher│◀ IRD
          │ (Job, batch)      │ │ (Pub/Sub push)  │ │ (Job, daily)  │
          └───────────────────┘ └─────────────────┘ └──────────────┘
```

**Hard rule:** `citetax-api` has a database role with `SELECT` only, and only on views filtered to `status = 'published'`. It is structurally incapable of serving an unreviewed rule.

### 2.4 Memory budget and model serving

**What happened in the first build.** The stack was brought up as one Docker Compose project on a development machine, with the embedding model and reranker loaded inside the application container alongside Postgres, Redis and the web app. It ran out of RAM and crashed.

**Diagnosis.** The cause is model *weights*, not vector data. Rough resident footprints at fp32:

| Component | Approx. RAM |
|---|---|
| BGE-M3 (XLM-RoBERTa large, ~568M params) | ~2.3 GB weights, plus activations that scale with batch size and sequence length |
| BGE reranker base (~278M params) | ~1.1 GB |
| Postgres 16 + shared buffers | ~0.5–1 GB |
| Next.js dev server | ~0.5 GB |
| FastAPI + Python runtime | ~0.3 GB |
| Redis | ~0.1 GB |

That is 5 GB before a single request, on a machine where Docker Desktop is typically capped at 2–4 GB by default. The crash was arithmetic, not a bug.

Worth stating plainly, because it changes the fix: **the corpus is small.** Sri Lankan personal income tax law for two years of assessment is on the order of a few thousand chunks. A few thousand 1024-dimension vectors is roughly 10–20 MB in Postgres, and an HNSW index over it is trivial. There is no data-volume problem here at all. The entire pressure is model weights held in a process that also has to do other work.

**Five design rules that follow.**

1. **One service holds weights, and it is not the API.** `citetax-embed` is the only container that loads BGE-M3 and the reranker. `citetax-api` never imports `torch` or `sentence-transformers`. Every other service talks to it over HTTP: `POST /embed` (batch) and `POST /rerank` (query + candidate passages).

2. **Serve quantised, not fp32.** Export both models to ONNX with int8 dynamic quantisation and serve with `onnxruntime`. This takes BGE-M3 to roughly 600 MB and the reranker to roughly 280 MB resident -both comfortable inside a 4 GiB Cloud Run instance with room for concurrent requests. Accuracy cost on retrieval is small; measure it against §11 targets before accepting, and fall back to fp16 if retrieval@1 drops below the target.

3. **Embedding is mostly an indexing-time cost.** Documents are embedded once, in a batch job, when a snapshot publishes. The interactive path embeds exactly one short query string per question. Size the service for the batch job, let it scale to zero between publishes, and accept a cold start on the indexer because nobody is waiting on it. The query path can tolerate one cold start per idle period, or set `min-instances=1` on `citetax-embed` only if p95 measurement demands it.

4. **The reranker only sees the shortlist.** Hybrid BM25 + dense retrieval returns top-20; the cross-encoder scores those 20 and nothing more. Reranking is quadratic in the wrong hands -cap it in code, not by convention.

5. **Developers do not run models locally.** The application reads `EMBEDDING_BACKEND` from config: `remote` (default -points at the deployed staging `citetax-embed`) or `local` (opt-in, for whoever has the RAM). Nobody's laptop needs 5 GB free to run the app. This single config switch is what prevents the first crash from recurring.

**Provider abstraction.** All embedding and rerank calls go through one interface:

```python
class EmbeddingProvider(Protocol):
    dim: int
    model_id: str
    def embed(self, texts: list[str]) -> list[list[float]]: ...

class RerankProvider(Protocol):
    def rerank(self, query: str, passages: list[str]) -> list[float]: ...
```

Implementations: `SelfHostedProvider` (the default, `citetax-embed`) and `VertexProvider` (Vertex AI embeddings). If self-hosting turns out to cost more than it is worth, the swap is one config line rather than a rewrite. **Decide before Phase 7 and not after**, because `chunk.embedding` is a fixed-dimension pgvector column and changing providers means changing `dim` and re-indexing the whole corpus. Store `embedding_model` and `dim` on every chunk row so a partial re-index is detectable.

**Per-service memory limits** (set explicitly in Cloud Run, not left at default):

| Service | Limit | Rationale |
|---|---|---|
| `citetax-embed` | 4 GiB / 2 vCPU | Weights + batch activations |
| `citetax-api` | 512 MiB / 1 vCPU | No weights; spaCy `sm` is ~12 MB |
| `citetax-admin` | 512 MiB / 1 vCPU | Impact preview runs the compute engine, which is pure Python |
| `citetax-web` | 512 MiB / 1 vCPU | Next.js standalone |
| `corpus-extractor` | 1 GiB / 1 vCPU | PDF parsing peaks on large gazettes |
| `corpus-indexer` (Job) | 1 GiB / 1 vCPU | Streams batches to `citetax-embed`; holds no weights itself |

A service that exceeds its limit should be treated as a design error to investigate, not a number to raise.

---

## 3. The corpus pipeline -the product edge

This is the part that makes Citetax different from a chatbot with a PDF in its context window. Specify it first, build it first.

### 3.1 Source registry

Each watched source is a row, not hardcoded:

| Field | Example |
|---|---|
| `source_id` | `ird-circulars` |
| `name` | IRD Circulars and Notices |
| `index_url` | IRD notices listing page |
| `discovery` | `html_list` \| `rss` \| `manual_upload` |
| `selector` | CSS/XPath for link rows |
| `doc_type` | `circular` \| `gazette` \| `act_amendment` \| `apit_table` \| `guideline` |
| `schedule` | `daily` |
| `priority` | `high` -affects reviewer SLA |
| `enabled` | true |

Manual upload is a first-class source. When a reviewer receives a PDF by other means, they drop it into the same pipeline and it gets the same lineage and audit treatment.

### 3.2 Detection

1. Watcher fetches each index page, extracts candidate document links.
2. For each link: fetch, compute `sha256` of the raw bytes.
3. If the hash is unseen → new `source_document`, store raw bytes in GCS, publish `source.changed`.
4. If the hash matches an existing document → no-op, update `last_seen_at`.
5. If the URL is known but the hash changed → **silent revision**. This is the August 2026 case. Create a new `source_document` with `revision_no = prev + 1`, `supersedes_id = prev.id`, and flag the proposal `revision_of_published` -highest reviewer priority, because a rule already serving users may now be wrong.

Document lineage is by `family_id`, so the three copies of one circular are three rows in one family with revisions 1, 2, 3 -never three competing documents.

### 3.3 Extraction

The extractor is an LLM-assisted parser, and its output is **a proposal, never a fact**.

Input: raw PDF/HTML + doc metadata.
Output: zero or more `change_proposal` rows, each containing:

| Field | Meaning |
|---|---|
| `rule_key` | Which rule this touches, e.g. `relief.personal`, `band.progressive`, `apit.table`, `deadline.return_filing` |
| `operation` | `create` \| `amend` \| `supersede` \| `no_change` |
| `value_json` | Structured value -band edges and rates, relief amount, date, threshold |
| `effective_from`, `effective_to` | Parsed effective window |
| `applies_to_ya` | Derived years of assessment |
| `source_anchor` | Page number + character span + bounding box in the source document |
| `quoted_text` | The exact sentence(s) the value came from |
| `confidence` | 0–1, from the extractor |
| `extractor_version` | For re-running and comparing extractor generations |

The extractor never writes to `rule_version`. It writes to `change_proposal`. The only path from proposal to rule is a human clicking approve.

### 3.4 Proposal state machine

```
detected ──▶ extracted ──▶ needs_review ──▶ in_review ──┬──▶ approved ──▶ published
                  │                             │       │
                  │                             ├──▶ changes_requested ──▶ in_review
                  ▼                             │
           extraction_failed                    └──▶ rejected
           (manual entry path)
```

- `published` rules can later become `superseded` when a newer version's effective window opens.
- `rejected` proposals are kept forever with the reason. They are training data for the extractor and evidence for the audit.

### 3.5 Publication

Publishing is not a row update. It creates a new **corpus snapshot**.

1. Reviewer (and, for rate/band/threshold changes, a second Approver) signs off.
2. System opens a transaction: insert new `rule_version` rows with `status='published'`, set `effective_to` on the versions they supersede, insert a `corpus_snapshot` row pointing at the resulting rule set.
3. Publish `corpus.published` → cache invalidation, retrieval re-index for the affected documents, snapshot label updated in the UI sidebar.
4. Total time from approve click to live: target under 60 seconds.

**Rollback** is selecting a previous `corpus_snapshot_id` and marking it current. Because every answer already records the snapshot it used, rollback never corrupts history -it just changes what new answers resolve against.

### 3.6 Rule resolution -deterministic, no LLM

```python
def resolve(rule_key: str, ya: str, snapshot_id: str) -> RuleVersion:
    """
    Pick the single rule version that governs `rule_key` for year of assessment `ya`,
    as the corpus stood at `snapshot_id`.
    Raises UnresolvedRule if zero or more than one candidate survives.
    """
```

Selection: `status='published'` AND in snapshot AND `effective_from <= ya_start` AND (`effective_to IS NULL` OR `effective_to >= ya_start`), ordered by `revision_no DESC`, take one.

If zero candidates → the computation stops and the answer is refused with "no rule in force found for X in YA Y". **Silence is a valid answer; a guess is not.**
If more than one candidate survives → data integrity alarm, page an admin, block the answer. This should be impossible and therefore must be monitored.

---

## 4. Agent design (redesigned)

Two graphs, not one. The corpus pipeline above is asynchronous and machine-paced. The answer graph below is synchronous and user-paced. The mid-evaluation design conflated them.

### 4.1 Answer graph (LangGraph, inside `citetax-api`)

| # | Node | Does | Fails to |
|---|---|---|---|
| 1 | **Intake** | Redact PII locally, parse question and/or payslip, spaCy NER for money/dates/employer, extract facts into a typed `TaxFacts` object | Leaking personal data to a hosted model |
| 2 | **Scope gate** | Is this personal income tax, in a supported YA, non-advisory? | Answering questions outside scope |
| 3 | **Clarify** | If `TaxFacts` is missing a required field, ask exactly one question and stop | Assuming income, filing status, or year |
| 4 | **Resolve** | Deterministic `resolve()` for every rule the computation will need | Applying superseded law |
| 5 | **Compute** | Pure Python engine over resolved rule versions | Untraceable numbers |
| 6 | **Comply** | Obligation, deadline, instalments, penalty exposure | Missed deadlines |
| 7 | **Retrieve** | Hybrid BM25 + BGE-M3 dense + BGE rerank over published chunks, filtered to the resolved documents -*for explanation only* | Explaining with the wrong document |
| 8 | **Explain** | LLM writes prose, constrained to the computed ledger and retrieved spans | Fluent invention |
| 9 | **Verify** | Numeric provenance check + citation completeness + egress PII scan | Uncited claims |

Scope gate moves to position 2 (it was late before) -out-of-scope questions now cost one cheap classification instead of a full retrieval and computation pass.

Retrieval moves *after* computation. The mid-evaluation design retrieved first and computed from what it found. Inverting this is the single most important change: **computation reads the rules table, not the search index.** Search is for prose the user reads, never for numbers the user relies on.

### 4.2 The verify node in detail

This is what earns the "All figures cited" badge.

1. Compute produces a **ledger**: an ordered list of `(step_no, label, rule_version_id, value)`.
2. Explain produces prose.
3. Verify extracts every numeric token from the prose (regex over currency, percentages, dates, ordinals).
4. Every extracted number must match either a ledger value, a value inside a cited `rule_version.value_json`, or an explicit allowlist (step counts, years of assessment, list ordinals).
5. Any unmatched number → regenerate once with the offending token named. Second failure → release the ledger and citations **without** the prose, and show "Explanation withheld -figures below are verified."

The user always gets the verified table. The prose is the part allowed to fail.

### 4.3 Computation engine

Pure Python module, no network, no model, fully unit-testable. Public signature:

```python
def compute(facts: TaxFacts, rules: ResolvedRuleSet) -> Computation:
    """Returns an ordered ledger of steps plus the balance payable.
    Every step carries the rule_version_id that produced it.
    Uses Decimal throughout. Rounding rule is per-rule, from the rules table."""
```

Canonical step sequence (employment income with APIT):

| Step | Label | Rule key |
|---|---|---|
| 1 | Assessable income | `income.assessable` |
| 2 | Less EPF employee contribution | `deduction.epf_employee` |
| 3 | Less qualifying payments / other deductions | `deduction.qualifying` |
| 4 | Less personal relief | `relief.personal` |
| 5 | Taxable income | `charge.taxable_income` |
| 6 | Gross tax across bands | `band.progressive` |
| 7 | Less tax credits (foreign, WHT) | `credit.*` |
| 8 | Less APIT already withheld | `credit.apit` |
| -| **Balance payable** | derived |

> **Open item flagged from the mid-evaluation deck.** The narrative says "computed from 8 steps" but the UI mock shows 6 rows plus the balance. The eight steps above are the proposal; steps that evaluate to zero should still render, greyed, with the rule cited, so the step count in the headline always matches the table. Confirm the final list with the group before the compute engine is written, because the ledger shape is baked into the API contract, the export format and the golden set.

---

## 5. Admin panel specification

The admin panel is where the product's claim is actually true. Spec it like a product surface, not a CRUD screen.

### 5.1 Screens

**A. Review inbox** -the reviewer's home.

Queue of proposals, sorted by risk then age. Each row: rule key, operation badge, source document + revision, confidence bar, age, SLA badge. Filters: doc type, rule key, status, assignee, `revision_of_published` only.

Priority ordering (highest first):
1. `revision_of_published` -a live rule may now be wrong
2. Rate, band or threshold changes
3. Deadline changes
4. New rules with no live counterpart
5. Editorial / guideline text

SLA targets: P1 within 4 hours, P2 within 24 hours, P3 within 5 days. Breaches surface on the corpus health dashboard.

**B. Document viewer** -split pane.

Left: the source document rendered, with the extracted span highlighted and scrolled into view. Right: the extracted values as an **editable form**, field by field, each with the quoted sentence beneath it.

The reviewer's job is to compare, correct, and sign -never to retype. If extraction got the relief amount right but the effective date wrong, they fix one field. Every edit is recorded as `reviewer_correction` with before/after, which becomes the extractor's evaluation set.

**C. Diff view.**

Field-level comparison of the currently published version against the proposal. Changed fields highlighted. Effective-window timeline showing where the new version sits relative to the old one, and whether it leaves a gap or an overlap. Gaps and overlaps are blocking errors -you cannot publish a corpus with an uncovered date range in a supported YA.

**D. Impact preview.** *(The feature that makes reviewing feel safe.)*

Before approving, run the golden set of taxpayer scenarios against the proposed corpus and show:

- N of M golden cases change
- Distribution of the change (min / median / max delta)
- A sample table: scenario, old balance payable, new balance payable, delta
- Any case that moves from "must file" to "need not file" or the reverse, called out separately -obligation flips are the highest-consequence change

The reviewer is approving a **consequence**, not a field.

**E. Publish.**

- Single approval for editorial and guideline changes.
- **Dual control** for anything in `value_json` that affects a computed figure: rate, band, threshold, relief, deadline. Second approver must be a different user; the UI names who is required.
- Publish dialog shows the snapshot label being created and a mandatory one-line changelog entry written by the approver. That line is what users see in "what changed".

**F. Corpus health.**

- Coverage matrix: rule keys × supported YAs, cell green if a published version covers the whole year, amber if partial, red if uncovered
- Staleness: days since each source last produced a change; a high-priority source silent for 90 days may mean the crawler broke, not that nothing happened
- Extractor failure rate, by source and extractor version
- Open proposals by age, SLA breaches
- Reviewer correction rate -how often reviewers change extractor output, per field. This is the number that tells you whether extraction is improving.

**G. User escalations.**

Users can flag any computation step ("this number looks wrong"). The flag lands here bound to `rule_version_id` + `computation_run_id`, so the reviewer sees exactly which rule version and which inputs produced the disputed figure, and can reproduce the answer at that snapshot.

**H. Audit log.**

Append-only. Who, what, when, before, after, from which IP, under which approval. Exportable as CSV and signed PDF. Never editable, never deletable, retained indefinitely. This is what a paying practice is actually buying.

**I. Source registry & rollback.**

CRUD for watched sources, crawl-now button, last-run status. Snapshot list with diff-against-previous and one-click rollback behind a confirmation that names the affected rule keys.

### 5.2 Admin panel layout

```
┌────────────────────────────────────────────────────────────────────┐
│ Citetax Admin        [Snapshot: 2026-08-18 #142]      Reviewer ▾   │
├──────────────┬─────────────────────────────────────────────────────┤
│ Review inbox │  ┌───────────────────┬────────────────────────────┐ │
│   ● 4 urgent │  │ SOURCE DOCUMENT   │ EXTRACTED RULE             │ │
│ Corpus health│  │                   │                            │ │
│ Snapshots    │  │  [rendered PDF,   │  rule_key   relief.personal│ │
│ Escalations  │  │   span highlighted│  operation  amend          │ │
│ Sources      │  │   in amber]       │  value      1,800,000 ✎    │ │
│ Audit log    │  │                   │  from       2026-04-01 ✎   │ │
│ Users        │  │                   │  to         -             │ │
│              │  │                   │  ──────────────────────    │ │
│              │  │                   │  "…quoted sentence from    │ │
│              │  │                   │   the source…"             │ │
│              │  └───────────────────┴────────────────────────────┘ │
│              │  ┌──── DIFF ────────┐ ┌──── IMPACT ──────────────┐ │
│              │  │ value            │ │ 42 of 120 golden cases   │ │
│              │  │  1,200,000 →     │ │ change. Median +LKR 2,400│ │
│              │  │  1,800,000       │ │ 3 obligation flips  →    │ │
│              │  └──────────────────┘ └──────────────────────────┘ │
│              │  [Request changes]  [Reject]  [Approve -needs 2nd] │
└──────────────┴─────────────────────────────────────────────────────┘
```

---

## 6. User interface specification

Based on the supplied mock, which is largely right. Below: what it establishes, and what it still needs.

### 6.1 Established layout

**Left rail (navy, fixed 300px).** Wordmark + "Every number, cited". Primary action *New question*. Nav: History, My profile, Deadlines. A *Year of assessment* selector -critical, because it is the axis every rule resolves against and it must never be implicit. Footer: **Corpus snapshot 18 August 2026**.

**Centre column.** User question as a navy bubble, right-aligned. Then the answer card: eyebrow label (`BALANCE PAYABLE, YEAR OF ASSESSMENT 2026/2027`), the figure at display size, an *All figures cited* pill, and two lines of context -step count and the return due date. Then a tab bar: **Computation | Citations | Agent trace | Explain this rule**. Then the computation table: `STEP | WHAT IT DOES | RULE | VALUE, LKR`, with a highlighted balance row.

**Right rail (360px).** *Citations* -one card per rule version, each showing the identifier and its effective dating. *Agent trace* -vertical timeline of the graph nodes, with the standing note that every figure is checked against a rule before release.

### 6.2 Required additions

| # | Addition | Why |
|---|---|---|
| 1 | **Corpus snapshot is clickable** → panel showing what changed since the previous snapshot, in the approvers' own changelog words | The freshness claim is currently a passive date. Make it explorable and it becomes the demo moment |
| 2 | **Citation cards show lineage** -"Revision 3 · supersedes the 6 Aug 2026 version" | This is the August 2026 story rendered as UI. Right now the cards show dates but not the supersession that is the whole point |
| 3 | **Badge has three states** -`All figures cited` (green) / `Partially cited -explanation withheld` (amber) / `Cannot answer -no rule in force` (grey) | The verify node can fail; the UI currently only depicts success |
| 4 | **Zero-value steps render greyed** rather than being dropped | Makes the headline step count match the visible table |
| 5 | **Per-step "flag this"** affordance on row hover | Feeds admin escalations; costs one icon |
| 6 | **Rule chips are clickable** → opens the Citations tab scrolled to that rule, with the quoted source text | Closes the loop from figure to law in one click |
| 7 | **"What changed this year" view** -the two supported YAs side by side, deltas, and the amendment responsible | Listed as a headline capability; has no surface in the mock |
| 8 | **Payslip upload** -dropzone in the composer, then a confirmation screen showing what was extracted and a redaction notice before anything is sent | Named as a paid feature; also where the privacy promise must be visible |
| 9 | **Refusal state** -same card chrome, reason, and a pointer to the correct IRD resource | Refusal is a designed output, so design it |
| 10 | **Empty / loading state** -agent trace timeline fills in as nodes complete | Turns a 6-second wait into visible work; the trace is already the right component |
| 11 | **Mobile** -right rail collapses into two more tabs; computation table becomes stacked rows | Most Sri Lankan filers will open this on a phone |

### 6.3 Design tokens

Sample from the mock and lock these into Tailwind config before any component is written:

| Token | Approx. value | Use |
|---|---|---|
| `navy-900` | `#1B2A6B` | Sidebar, question bubble, headline figure |
| `navy-700` | `#2A3A85` | Sidebar active item |
| `indigo-50` | `#E8EDFA` | Citation cards, badge, balance row |
| `slate-50` | `#F5F7FB` | App background |
| `white` | `#FFFFFF` | Cards |
| `slate-500` | `#6B7280` | Eyebrow labels, table headers |
| Radius | 12px cards, 8px chips, 999px pills | |
| Type | One sans family; figure at ~48px/600, body 15px/400, eyebrow 12px/500 uppercase, +0.05em tracking | |

Accessibility: WCAG AA contrast on every text pairing, full keyboard traversal of the tab bar and table, `aria-live` on the answer card so the figure is announced when it resolves.

---

## 7. Data model

```sql
source_document(
  id, family_id, revision_no, source_id, url, sha256, gcs_uri,
  doc_type, published_at, fetched_at, supersedes_id, title
)

change_proposal(
  id, source_document_id, rule_key, operation, value_json,
  effective_from, effective_to, applies_to_ya[],
  source_anchor_json, quoted_text, confidence, extractor_version,
  status, priority, assigned_to, created_at
)

rule(rule_key PK, title, rule_type, unit, rounding_mode)

rule_version(
  id, rule_key FK, revision_no, value_json,
  effective_from, effective_to,
  source_document_id, source_anchor_json, quoted_text,
  status, supersedes_version_id,
  approved_by, approved_at, second_approved_by, second_approved_at,
  changelog_line
)

corpus_snapshot(id, label, created_at, created_by, is_current, changelog)
snapshot_rule_version(snapshot_id, rule_version_id)   -- membership

chunk(
  id, source_document_id, text, embedding vector(1024),
  embedding_model, embedding_dim, indexed_at,     -- detects partial re-index
  tsv tsvector, applies_to_ya[], status
)

computation_run(
  id, user_ref, ya, facts_redacted_json, ledger_json,
  rule_version_ids[], corpus_snapshot_id, answer_text,
  verify_result, latency_ms, model, created_at
)

review_event(id, actor, action, target_type, target_id, before_json, after_json, at)
escalation(id, computation_run_id, step_no, rule_version_id, note, status)
```

Indexes: `chunk` HNSW on `embedding`, GIN on `tsv`; `rule_version` composite on `(rule_key, effective_from, effective_to, status)`; `change_proposal` on `(status, priority, created_at)`.

---

## 8. API surface

**Public**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/ask` | Question + optional payslip → answer, ledger, citations, trace, snapshot id |
| `POST` | `/v1/compute` | Structured facts → ledger only, no LLM in path |
| `GET` | `/v1/obligation?ya=` | Filing obligation check |
| `GET` | `/v1/deadlines?ya=` | Dates and instalments |
| `GET` | `/v1/compare?from=&to=` | Year-on-year comparison |
| `GET` | `/v1/rules/{rule_key}?ya=` | Resolved rule version with source anchor |
| `GET` | `/v1/snapshot/current` | Snapshot id, label, changelog |
| `POST` | `/v1/runs/{id}/flag` | User escalation |
| `GET` | `/v1/runs/{id}/export` | Signed URL, PDF/CSV computation export |

**Admin** (IAP-protected)

`GET /admin/proposals` · `GET /admin/proposals/{id}` · `PATCH /admin/proposals/{id}` · `POST /admin/proposals/{id}/approve` · `POST /admin/proposals/{id}/reject` · `POST /admin/proposals/{id}/impact` · `POST /admin/snapshots/publish` · `POST /admin/snapshots/{id}/rollback` · `GET /admin/health/corpus` · `GET /admin/audit` · `CRUD /admin/sources` · `POST /admin/sources/{id}/crawl`

**MCP tools** (same functions, exposed for agent use): `resolve_rule`, `compute_tax`, `check_obligation`, `get_deadlines`, `search_corpus`, `get_snapshot`.

---

## 9. Responsible AI

| Guarantee | Mechanism |
|---|---|
| **Identifiers never reach the hosted model** | Coded redaction module + spaCy NER + structured minimisation in the Intake node, before any Groq call. See §9.1 |
| **Payslip text never reaches the hosted model at all** | Only extracted numeric facts continue past Intake; the OCR/parse text is discarded |
| **No invented figures** | LLM is absent from the computation path. Verify node rejects any number without provenance |
| **No outdated law** | Every figure resolves through `resolve()` with an effective window; retrieval filtered to the resolved documents |
| **No unreviewed law** | `citetax-api` reads a published-only view; extraction cannot write to `rule_version` |
| **No advice** | Scope gate refuses advisory phrasing with a reason |
| **Nothing hidden** | Every step opens to its rule, quoted source text and effective dates; the agent trace is shown, not summarised |
| **Reproducible** | Every run stores its `corpus_snapshot_id`; any answer can be re-derived exactly as it stood |

Retention: raw payslips deleted after processing, never persisted. `computation_run.facts_redacted_json` holds only the numeric facts needed to reproduce a computation. Users can delete their history; audit records the deletion, not the data.

### 9.1 The privacy layer, coded

The mid-evaluation design put a small local LLM in front of everything to screen what users send. **That is not affordable on current resources** -a model large enough to be a useful classifier is a second set of weights on top of §2.4's problem, and the crash already showed there is no headroom. The privacy layer is therefore written as code.

This is a genuine downgrade in one dimension and an upgrade in two others, and the spec should say so rather than paper over it.

**Architecture: minimise first, redact second.**

The strongest privacy control is not scrubbing text well. It is not sending the text. The Intake node parses the user's message into a typed `TaxFacts` object -income amounts, EPF contribution, APIT withheld, year of assessment, filing status, income types. **Downstream nodes receive `TaxFacts`, not the original string.** The hosted model is called twice: once at the scope gate (with a truncated, redacted question) and once at Explain (with the computed ledger, the retrieved law text, and a redacted question skeleton). At neither point does it need a name, an employer or an ID number, because none of those affect a tax computation.

Redaction is the second line, for the free-text remnant that does travel.

**Detection, in order of precedence:**

| Class | Method | Pattern notes |
|---|---|---|
| NIC (old) | Regex | 9 digits + `V`/`X`, case-insensitive |
| NIC (new) | Regex | 12 digits, with a birth-date-plausibility check on positions 5–7 to cut false positives |
| TIN | Regex + context | 9 digits near tax-context keywords |
| Phone | Regex | `+94`, `0` + 9 digits, common separators |
| Email | Regex | Standard |
| Bank / EPF member no. | Regex + context keyword | Requires a nearby keyword to fire |
| Passport | Regex | `N`/`M` + 7 digits |
| Person names | spaCy `en_core_web_sm` NER, `PERSON` | ~12 MB, in-process, no memory concern |
| Employer / organisation | spaCy NER, `ORG` | |
| Addresses | spaCy `GPE`/`LOC` + street-keyword heuristics | Weakest detector; see limitations |

Each replaced with a stable typed placeholder: `<NIC>`, `<TIN>`, `<PERSON_1>`, `<EMPLOYER>`. Stable numbering so pronoun reference survives redaction.

**Money must survive.** The redactor's hardest job is not finding IDs -it is *not* destroying the figures the computation needs. Rule: a numeric token is retained if it carries a currency marker, a thousands separator, a decimal, or a nearby income keyword; it is a redaction candidate only if it is a bare 9- or 12-digit run. Cases where a salary could be mistaken for an NIC are excluded by digit count in practice, but this is exactly what the test set in §11 exists to prove.

**Fail-closed.** Ambiguity redacts. A token that partially matches a sensitive pattern is replaced, and the placeholder is logged so the behaviour is measurable. Over-redaction degrades an explanation; under-redaction leaks a taxpayer's identity. The asymmetry is not close.

**Honest limitations.** Written down deliberately, because a spec that hides them produces a demo that lies:

- Recall on **Sinhala and Tamil names**, and on romanised transliterations, is lower than an LLM screener would achieve. `en_core_web_sm` is trained on English news text. Mitigation: a gazetteer of common Sri Lankan given names and surnames layered over the NER output, plus the minimisation architecture that means a missed name usually has nowhere to travel to anyway.
- **Novel or unusual employer names** may not be tagged `ORG`.
- Free-text addresses in unusual formats are the weakest case.
- A coded redactor **cannot judge intent**, so it cannot block a user from volunteering something sensitive in a way no pattern matches.

**Compensating controls:** minimisation (the main one), a truncation cap on how much free text is forwarded at all, egress scanning in the Verify node so a leak is caught on the way out as well as on the way in, and a measurable leak rate on a held-out test set rather than an assumed one.

**Upgrade path.** The redactor sits behind one interface, `Redactor.redact(text) -> RedactedText`. When resources allow, a model-based implementation drops in behind it and the coded version becomes the fallback and the regression baseline. The interface is written now; the implementation is deferred.

> **Deck correction.** The mid-evaluation slide claims "A local model checks anything a user sends" and "Nothing private leaves the machine." Neither is true of this build. The accurate claim is stronger anyway, because it is verifiable: *"Identifiers are stripped by a deterministic redaction layer with a measured leak rate, and the hosted model is only ever sent structured facts and law text -never a payslip, never an identity."* Update the slide before the next presentation; a panel that catches an overclaim will discount everything else.

---

## 10. Non-functional requirements

| Requirement | Target |
|---|---|
| Answer latency, computation question | p50 ≤ 4 s, p95 ≤ 9 s |
| `/v1/compute` (no LLM) | p95 ≤ 300 ms |
| Compute engine, in-process | ≤ 50 ms |
| Corpus publish → live | ≤ 60 s |
| Source change → proposal in queue | ≤ 24 h (daily crawl), ≤ 5 min once detected |
| Query embedding round-trip (`citetax-embed`, warm) | p95 ≤ 150 ms |
| Rerank of 20 passages (warm) | p95 ≤ 400 ms |
| `citetax-embed` cold start | ≤ 15 s; must not block the answer path more than once per idle period |
| Peak RSS, any service | Within the §2.4 limit, verified under load test |
| `citetax-api` resident memory | ≤ 400 MiB -no model weights, ever |
| Full corpus re-index | ≤ 20 min for the whole two-year corpus |
| Availability | 99.5% monthly on the answer path |
| Concurrency | 50 simultaneous answers without queueing |
| Cost | Serverless floor + per-answer marginal cost under LKR 5 |

---

## 11. Evaluation

**Golden set** -120+ taxpayer scenarios across both supported years: salaried only, salaried + APIT credit, freelance above and below threshold, mixed income, edge cases at every band boundary and at the relief threshold. Each has a hand-computed expected balance signed off by a reviewer.

| Metric | Target |
|---|---|
| Computation exactness vs. hand-computed golden set | 100% -a single mismatch is a release blocker |
| Correct rule version selected (retrieval@1 on `rule_key` + YA) | ≥ 0.98 |
| Citation completeness -every released figure has a `rule_version_id` | 100% by construction; verify node measures it |
| Out-of-scope refusal rate on the adversarial set | ≥ 0.95 |
| Hallucinated-number rate after verify | 0 |
| Extraction precision on reviewer-corrected proposals | ≥ 0.85 and rising per extractor version |
| **Identifier leak rate** on the redaction test set (structured IDs: NIC, TIN, phone, email, passport) | 0 |
| **Name / employer recall** on the redaction test set | ≥ 0.90, reported honestly -this is where a coded redactor is weakest |
| **Money-token survival** -figures needed for computation not destroyed by redaction | 100% |
| Retrieval@1 delta, int8-quantised vs fp32 models | ≤ 0.01 absolute; larger regression means fall back to fp16 |

**Redaction test set.** 200+ constructed messages and payslips spanning: Sinhala, Tamil and romanised names; both NIC formats; salary figures adjacent to ID-shaped numbers; employer names of varying obscurity; free-text addresses; and adversarial cases that try to smuggle an identifier past the patterns. Built once, run in CI on every change to the redactor. Report recall per class rather than one aggregate number, because a 0.95 average that hides 0.60 on Tamil names is not a passing grade.

Golden set runs in CI on every commit to the compute engine or rules schema, and again in impact preview before every publish.

---

## 12. Build order

Each phase produces something the next phase can rely on. Corpus before agents -the mid-evaluation build did this the other way round.

| Phase | Deliverable | Done when |
|---|---|---|
| **0. Foundations** | Cloud SQL schema, GCS buckets, Cloud Run skeletons with explicit memory limits, CI to Artifact Registry, IAP on admin, `EMBEDDING_BACKEND` config switch | A hello-world admin route is reachable only through IAP; no developer needs 5 GB free RAM to run the app |
| **1. Rules & resolution** | `rule`, `rule_version`, `corpus_snapshot`, `resolve()`, both YAs seeded and reviewer-signed | `resolve()` returns exactly one version for every rule key × YA, with tests for gaps and overlaps |
| **2. Compute engine** | Pure Python ledger engine + golden set v1 | 100% on the golden set, no network calls in the module |
| **3. Admin panel v1** | Review inbox, document viewer, diff, approve/reject, audit log, publish, rollback | A reviewer can take a manually uploaded PDF to a published snapshot without a developer |
| **4. Corpus pipeline** | Source registry, watcher job, hash-diff detection, extractor, proposal queue | A silent revision of a watched circular appears in the inbox as P1 within a day |
| **5. Impact preview** | Golden set run against a proposed snapshot, obligation-flip detection | Reviewer sees consequence before approval |
| **6. Answer graph** | LangGraph nodes 1–9, scope gate, clarify loop, verify node, `Redactor` interface + v1 regex/NER patterns, `TaxFacts` minimisation | Verify blocks a deliberately hallucinated figure in test; no raw user string reaches a hosted call |
| **6.5. Embed service** | `citetax-embed` deployed with ONNX int8 weights, `EmbeddingProvider` interface, `corpus-indexer` job | Peak RSS under 4 GiB at batch size; `citetax-api` image contains no `torch` |
| **7. Retrieval & explanation** | Chunking, BGE-M3 + BM25 hybrid, reranker capped at top-20, constrained explanation | Retrieval@1 ≥ 0.98 on the rule-selection set, quantised |
| **8. Interface** | The mock, built, plus all eleven additions in §6.2 | Snapshot panel, lineage on citations, three badge states, refusal state |
| **9. NLP inputs** | Payslip NER, query expansion, clarify-question quality | Payslip → correct `TaxFacts` on the payslip test set |
| **10. Compliance depth** | Penalties, instalments, obligation edge cases | Compliance golden set passes |
| **11. Security & privacy** | Auth, rate limits, prompt-injection defence, coded `Redactor` + gazetteer, 200-case redaction test set, egress scan, Cloud Armor | Zero structured-identifier leaks; name recall ≥ 0.90 reported per class; injection suite passes |
| **12. Evaluation & launch** | Corpus expansion, golden set to 120+, load test, smoke tests in prod | All §11 targets met on the deployed environment |

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| IRD changes its site structure and the crawler silently stops | Staleness monitoring on the corpus health dashboard; a high-priority source with no activity for 90 days raises an alert |
| No reviewer available when a P1 revision lands | SLA breach alerting; a rule whose source has a pending `revision_of_published` proposal is flagged in the user-facing citation card as "under review" |
| Extraction confidently misreads a band table | Dual control on all value-bearing changes; impact preview surfaces the consequence; golden set is the backstop |
| Groq availability or model deprecation | Explanation is the only LLM-dependent output and it degrades to "figures without prose". Computation and citations are unaffected |
| Cloud SQL cost floor exceeds a student budget | Documented fallback in §2.2 |
| **Memory exhaustion recurs** -the first build's failure mode | Weights isolated to one service (§2.4), explicit per-service limits, `EMBEDDING_BACKEND=remote` by default so no laptop loads a model, peak-RSS check in the load test |
| **Quantisation degrades retrieval** below the §11 target | Measured, not assumed: retrieval@1 compared fp32 vs int8 before adoption, with fp16 as the documented fallback |
| **Coded redactor misses a Sinhala or Tamil name** | Minimisation means most free text never travels; gazetteer over NER; egress scan in Verify; per-class recall reported rather than averaged away; model-based `Redactor` drops in behind the same interface when resources allow |
| **Embed service cold start hurts p95** | Query embedding is one short string; measure first, and only buy `min-instances=1` on `citetax-embed` if measurement demands it |
| Liability from a wrong figure | No-advice scope gate, refusal design, visible effective dates, exportable audit trail, terms stating Citetax is a computation aid and not a tax agent |

---

## Appendix A -Entitlements

| Capability | Free | Individual (LKR 1,500 / season) | Practice (LKR 7,500 / seat / month) |
|---|:--:|:--:|:--:|
| Obligation check | ✓ | ✓ | ✓ |
| Deadline reminders | ✓ | ✓ | ✓ |
| Computations | 1 per YA | Unlimited | Unlimited |
| Payslip upload | -| ✓ | ✓ |
| Year-on-year comparison | -| ✓ | ✓ |
| Computation export | -| ✓ | ✓ branded |
| Multi-client workspace | -| -| ✓ |
| Bulk checking | -| -| ✓ |
| Full audit trail | -| -| ✓ |

The Practice tier sells the audit trail. A practice cannot bill for an answer it cannot check -so the exportable, snapshot-stamped, rule-cited computation record *is* the product at that tier.

## Appendix B -Open items for the group

1. **Final step list** for the compute ledger (§4.3) -eight or six, and whether zero-value steps render.
2. **Reviewer sourcing** -who signs off in practice? A contracted tax professional, a supervising lecturer, or a documented internal process with a stated limitation. This affects what the product may honestly claim.
3. **Second-approver rule** for a three-person team -dual control needs two distinct humans; decide who they are.
4. **Cloud SQL vs. budget** -resolve before Phase 0.
5. **Which years of assessment**, exactly, and their band tables locked and signed before Phase 1.
6. **Embedding provider -self-hosted BGE-M3 or Vertex AI** -decide before Phase 7. This fixes the pgvector column dimension, and changing it later means a full re-index. Self-hosting keeps BGE-M3's multilingual strength for Sinhala and Tamil source text; Vertex removes the 4 GiB service entirely. Run both against the retrieval eval set on the real corpus and pick on evidence.
7. **Privacy slide must be rewritten** before the next presentation (§9.1). The current claim describes a local model the build does not have.
8. **Who owns the redaction test set** -it needs Sinhala and Tamil name coverage, which is a data-collection task with a real cost, not an afternoon of regex.
