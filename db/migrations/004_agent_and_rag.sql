-- Citetax migration 004: the corpus agent, extraction provenance, and RAG.

-- ---------------------------------------------------------------------------
-- What the extractor decided and why, so a reviewer sees rationale and the
-- extractor's own output next to the editable fields.
-- ---------------------------------------------------------------------------
alter table change_proposal
  add column if not exists rationale text,
  add column if not exists extraction_json jsonb;

-- What kind of document this is, per the extractor, and whether it is relevant.
alter table source_document
  add column if not exists text_meta jsonb;

-- Manual crawl or the agent, so the health screen can tell them apart.
alter table crawl_run
  add column if not exists triggered_by text not null default 'manual';

-- ---------------------------------------------------------------------------
-- Every autonomous cycle the corpus agent runs. Crawled, extracted, indexed,
-- and what went wrong. This is how you tell "nothing happened" from "the agent
-- stopped running".
-- ---------------------------------------------------------------------------
create table if not exists agent_cycle (
  id                  uuid primary key,
  trigger             text not null default 'scheduler',   -- scheduler | manual
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  crawled_sources     int default 0,
  new_documents       int default 0,
  revisions           int default 0,
  extracted_documents int default 0,
  proposals_created   int default 0,
  chunks_indexed      int default 0,
  llm_tokens          int default 0,
  errors              jsonb,
  summary             text
);
create index if not exists idx_agent_cycle_started on agent_cycle(started_at desc);

-- ---------------------------------------------------------------------------
-- Answers now record which path the planner took and how much model time it
-- cost, so "did the agent do the right thing" is measurable per question.
-- ---------------------------------------------------------------------------
alter table computation_run
  add column if not exists intent text,
  add column if not exists plan jsonb,
  add column if not exists llm_usage jsonb,
  add column if not exists question_redacted text;
