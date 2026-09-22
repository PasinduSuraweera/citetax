-- Citetax migration 007: persistent conversations.
--
-- A conversation is one independent chat thread owned by one user. PostgreSQL
-- is its store of record. The browser keeps nothing but the id in the URL, so
-- a thread survives a refresh, a sign out and a change of device.
--
-- The tax record does not move. An assistant message that produced an answer
-- points at its computation_run, which keeps the snapshot, the rule versions,
-- the ledger and the verify result. Messages never copy those fields, so the
-- authoritative figures exist exactly once, and opening an old thread reads
-- the answer as it was given instead of computing it again.
--
-- Additive only. No existing table changes and nothing is backfilled: runs
-- from before this migration stay in History.

create table if not exists conversation (
  id          uuid primary key default gen_random_uuid(),
  -- Deleting an account deletes its conversations. The runs stay, as they do
  -- for a deleted conversation, because they are the audit record.
  user_id     uuid not null references app_user(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 120),
  created_at  timestamptz not null default now(),
  -- Last activity: moves when a turn is added, not when the chat is renamed,
  -- so renaming a chat does not reorder the sidebar.
  updated_at  timestamptz not null default now()
);

-- The sidebar reads one user's chats, most recently active first. The id is
-- the tie break so keyset pagination never skips or repeats a row.
create index if not exists idx_conversation_user_recent
  on conversation(user_id, updated_at desc, id desc);

create table if not exists conversation_message (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversation(id) on delete cascade,
  -- Order within the thread. Allocated under a row lock on the conversation,
  -- never taken from created_at, because now() is the transaction start and
  -- both messages of a turn share it.
  seq                int  not null check (seq >= 1),
  role               text not null check (role in ('user','assistant')),
  kind               text check (kind in ('answer','refusal','clarify')),
  -- The user side is the redacted question, never the raw text. The assistant
  -- side is the verified explanation, the refusal reason or the clarifying
  -- question.
  content            text not null default '',
  -- No cascade in either direction. Deleting a conversation removes its
  -- messages and leaves the runs that History and escalations point at.
  computation_run_id uuid references computation_run(id),
  -- What the answer showed that no other table keeps (trace, citations as
  -- shown, passages, filing card, comparison). When a run exists the ledger,
  -- explanation, verify result, snapshot and model usage are left out and read
  -- from the run instead.
  response_json      jsonb,
  created_at         timestamptz not null default now(),
  unique (conversation_id, seq),
  check (role = 'assistant'
         or (kind is null and computation_run_id is null and response_json is null)),
  check (role = 'user' or kind is not null)
);

-- Finds the messages that point at a run, which is also what a delete of a
-- run has to check before the foreign key lets it through.
create index if not exists idx_conversation_message_run
  on conversation_message(computation_run_id)
  where computation_run_id is not null;
