-- Plans (Free, Individual, Team) and upgrade requests.
--
-- A plan is what an account pays for; a role is what it may do (review,
-- approve, administer). They are separate columns because they change for
-- different reasons: an approver can be on any plan, and every new account
-- starts with the role "individual" whatever it pays.
--
-- There is no payment gateway yet. Someone asks for a plan, an admin grants
-- it, and the grant is recorded with who gave it and when.

alter table app_user
  add column if not exists plan text not null default 'free'
    check (plan in ('free', 'individual', 'team'));
alter table app_user add column if not exists plan_granted_by text;
alter table app_user add column if not exists plan_granted_at timestamptz;

create table if not exists plan_request (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_user(id) on delete cascade,
  plan        text not null check (plan in ('individual', 'team')),
  seats       int  not null default 1 check (seats between 1 and 500),
  note        text,
  status      text not null default 'open'
                check (status in ('open', 'granted', 'declined', 'withdrawn')),
  created_at  timestamptz not null default now(),
  decided_by  text,
  decided_at  timestamptz
);
-- One open request per person: asking again replaces the plan they asked for.
create unique index if not exists idx_plan_request_open
  on plan_request(user_id) where status = 'open';
create index if not exists idx_plan_request_status on plan_request(status, created_at desc);

-- Monthly usage is counted from the runs a person's answers produced.
create index if not exists idx_run_user_month on computation_run(user_id, created_at);
