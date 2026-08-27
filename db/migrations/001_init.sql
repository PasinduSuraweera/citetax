-- Citetax schema — spec §7
-- Target: Supabase Postgres 16 with pgvector.
-- Embedding dim 768 = Vertex AI text-embedding-004. Changing provider means
-- changing this number AND a full re-index (spec §2.4).

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Source documents — lineage by family_id, revisions within a family (§3.2)
-- ---------------------------------------------------------------------------
create table if not exists source_document (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null,
  revision_no     int  not null default 1,
  source_id       text not null,
  url             text,
  sha256          text not null,
  gcs_uri         text,
  doc_type        text not null check (doc_type in
                    ('circular','gazette','act_amendment','apit_table','guideline')),
  title           text,
  published_at    date,
  fetched_at      timestamptz not null default now(),
  supersedes_id   uuid references source_document(id),
  unique (family_id, revision_no)
);
create index if not exists idx_srcdoc_sha on source_document(sha256);
create index if not exists idx_srcdoc_family on source_document(family_id, revision_no desc);

-- ---------------------------------------------------------------------------
-- Rules and their versions (§3.6). The extractor may NEVER write to rule_version.
-- ---------------------------------------------------------------------------
create table if not exists rule (
  rule_key      text primary key,
  title         text not null,
  rule_type     text not null,   -- amount | rate_table | date | flag | rate
  unit          text,            -- LKR | percent | date | boolean
  rounding_mode text not null default 'half_up'
);

create table if not exists rule_version (
  id                   uuid primary key default gen_random_uuid(),
  rule_key             text not null references rule(rule_key),
  revision_no          int  not null default 1,
  value_json           jsonb not null,
  effective_from       date not null,
  effective_to         date,
  source_document_id   uuid references source_document(id),
  source_anchor_json   jsonb,
  quoted_text          text,
  citation_label       text,          -- what the UI citation card shows, e.g. "Act s.5"
  status               text not null default 'draft'
                         check (status in ('draft','published','superseded','rejected')),
  supersedes_version_id uuid references rule_version(id),
  approved_by          text,
  approved_at          timestamptz,
  second_approved_by   text,
  second_approved_at   timestamptz,
  changelog_line       text,
  created_at           timestamptz not null default now()
);
-- Composite index for resolve() — spec §7
create index if not exists idx_rv_resolve
  on rule_version(rule_key, effective_from, effective_to, status);

-- ---------------------------------------------------------------------------
-- Corpus snapshots — publication is a new snapshot, never a row update (§3.5)
-- ---------------------------------------------------------------------------
create table if not exists corpus_snapshot (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  created_at timestamptz not null default now(),
  created_by text,
  is_current boolean not null default false,
  changelog  text
);
-- At most one current snapshot, enforced by the database rather than by hope.
create unique index if not exists idx_snapshot_one_current
  on corpus_snapshot(is_current) where is_current;

create table if not exists snapshot_rule_version (
  snapshot_id     uuid not null references corpus_snapshot(id) on delete cascade,
  rule_version_id uuid not null references rule_version(id),
  primary key (snapshot_id, rule_version_id)
);

-- ---------------------------------------------------------------------------
-- Change proposals — extractor output. Human approval is the only path out (§3.3)
-- ---------------------------------------------------------------------------
create table if not exists change_proposal (
  id                 uuid primary key default gen_random_uuid(),
  source_document_id uuid references source_document(id),
  rule_key           text,
  operation          text check (operation in ('create','amend','supersede','no_change')),
  value_json         jsonb,
  effective_from     date,
  effective_to       date,
  applies_to_ya      text[],
  source_anchor_json jsonb,
  quoted_text        text,
  confidence         numeric(3,2),
  extractor_version  text,
  status             text not null default 'needs_review'
                       check (status in ('detected','extracted','needs_review','in_review',
                                         'changes_requested','approved','published',
                                         'rejected','extraction_failed')),
  priority           int not null default 3,   -- 1 = revision_of_published
  assigned_to        text,
  reject_reason      text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_proposal_queue
  on change_proposal(status, priority, created_at);

-- ---------------------------------------------------------------------------
-- Retrieval chunks — explanation prose only, never numbers (§4.1 node 7)
-- ---------------------------------------------------------------------------
create table if not exists chunk (
  id                 uuid primary key default gen_random_uuid(),
  source_document_id uuid references source_document(id),
  rule_key           text,
  text               text not null,
  embedding          vector(768),
  embedding_model    text,
  embedding_dim      int,
  indexed_at         timestamptz,
  tsv                tsvector generated always as (to_tsvector('english', text)) stored,
  applies_to_ya      text[],
  status             text not null default 'published'
);
create index if not exists idx_chunk_tsv on chunk using gin(tsv);
create index if not exists idx_chunk_hnsw
  on chunk using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Runs, escalations, audit
-- ---------------------------------------------------------------------------
create table if not exists computation_run (
  id                 uuid primary key default gen_random_uuid(),
  user_ref           text,
  ya                 text not null,
  facts_redacted_json jsonb,
  ledger_json        jsonb,
  rule_version_ids   uuid[],
  corpus_snapshot_id uuid references corpus_snapshot(id),
  answer_text        text,
  verify_result      jsonb,
  latency_ms         int,
  model              text,
  created_at         timestamptz not null default now()
);

create table if not exists review_event (
  id          uuid primary key default gen_random_uuid(),
  actor       text,
  action      text,
  target_type text,
  target_id   text,
  before_json jsonb,
  after_json  jsonb,
  at          timestamptz not null default now()
);

create table if not exists escalation (
  id                 uuid primary key default gen_random_uuid(),
  computation_run_id uuid references computation_run(id),
  step_no            int,
  rule_version_id    uuid references rule_version(id),
  note               text,
  status             text not null default 'open',
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Published-only views. citetax-api gets SELECT on these and nothing else,
-- so it is structurally incapable of serving an unreviewed rule (§2.3).
-- ---------------------------------------------------------------------------
create or replace view v_published_rule_version as
  select * from rule_version where status in ('published','superseded');

create or replace view v_published_chunk as
  select * from chunk where status = 'published';
