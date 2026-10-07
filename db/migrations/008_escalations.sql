-- Citetax migration 008: escalations that can be closed.
--
-- A flag records who raised it (null when asked without an account), and a
-- reviewer closes it as resolved or dismissed with a note. Additive only.

alter table escalation add column if not exists flagged_by   uuid references app_user(id) on delete set null;
alter table escalation add column if not exists resolved_by  text;
alter table escalation add column if not exists resolved_at  timestamptz;
alter table escalation add column if not exists resolution   text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'escalation_status_check'
  ) then
    alter table escalation add constraint escalation_status_check
      check (status in ('open', 'resolved', 'dismissed'));
  end if;
end $$;

-- One open flag per step of a run: flagging the same figure again is the
-- same complaint, not a new one.
create unique index if not exists uq_escalation_open_step
  on escalation(computation_run_id, step_no) where status = 'open';

create index if not exists idx_escalation_status on escalation(status, created_at desc);
