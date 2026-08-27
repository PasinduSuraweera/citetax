-- Citetax migration 002: accounts, roles, and the review pipeline.
-- Run this in the Supabase SQL editor after 001_init.sql.

-- ---------------------------------------------------------------------------
-- Accounts. Identity comes from Google via NextAuth; this table holds the
-- role, because dual control needs two distinct named humans (spec section 5.1 E).
-- ---------------------------------------------------------------------------
create table if not exists app_user (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text,
  picture       text,
  role          text not null default 'individual'
                  check (role in ('free','individual','practice',
                                  'reviewer','approver','admin','auditor')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create index if not exists idx_app_user_email on app_user(lower(email));

-- Runs belong to a user so History can show only your own.
alter table computation_run
  add column if not exists user_id uuid references app_user(id);
create index if not exists idx_run_user
  on computation_run(user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Source registry (spec section 3.1). Each watched source is a row, never
-- hardcoded, so a reviewer can add one without a deploy.
-- ---------------------------------------------------------------------------
create table if not exists source (
  source_id     text primary key,
  name          text not null,
  index_url     text not null,
  discovery     text not null default 'html_list'
                  check (discovery in ('html_list','rss','manual_upload')),
  selector      text,
  doc_type      text not null,
  schedule      text not null default 'daily',
  priority      text not null default 'normal'
                  check (priority in ('high','normal','low')),
  enabled       boolean not null default true,
  last_run_at   timestamptz,
  last_status   text,
  last_error    text,
  last_change_at timestamptz,
  created_at    timestamptz not null default now()
);

-- The watcher records every crawl so staleness is measurable: a high priority
-- source silent for 90 days may mean the crawler broke, not that nothing
-- happened (spec section 5.1 F).
create table if not exists crawl_run (
  id            uuid primary key default gen_random_uuid(),
  source_id     text references source(source_id) on delete cascade,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                  check (status in ('running','ok','failed')),
  links_found   int default 0,
  new_documents int default 0,
  revisions     int default 0,
  error         text
);
create index if not exists idx_crawl_source on crawl_run(source_id, started_at desc);

-- Proposals need a reviewer trail and a place to record corrections, which
-- become the extractor's evaluation set (spec section 5.1 B).
alter table change_proposal
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists corrected_json jsonb;

create table if not exists reviewer_correction (
  id           uuid primary key default gen_random_uuid(),
  proposal_id  uuid references change_proposal(id) on delete cascade,
  field        text not null,
  before_value text,
  after_value  text,
  actor        text,
  at           timestamptz not null default now()
);

-- Documents that arrive by reviewer upload rather than by crawl.
alter table source_document
  add column if not exists uploaded_by text,
  add column if not exists raw_text text,
  add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------------------
-- Seed the registry with the source the user named.
-- ---------------------------------------------------------------------------
-- Corrected by 003_fix_sources.sql after testing against the live sites.
insert into source (source_id, name, index_url, discovery, doc_type, priority)
values
  ('taxadvisor-notices', 'Tax Advisor LK notices',
   'https://www.taxadvisor.lk/notice', 'html_list', 'circular', 'high'),
  ('taxadvisor-articles', 'Tax Advisor LK articles',
   'https://www.taxadvisor.lk/articles', 'html_list', 'guideline', 'normal'),
  ('ird-publications', 'IRD publications',
   'https://www.ird.gov.lk/en/publications/sitepages/home.aspx',
   'html_list', 'circular', 'high'),
  ('manual-upload', 'Reviewer upload',
   'about:blank', 'manual_upload', 'circular', 'normal')
on conflict (source_id) do nothing;
