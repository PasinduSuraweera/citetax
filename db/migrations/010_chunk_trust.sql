-- Citetax migration 010: how far a retrieved passage can be trusted (#44).
--
-- approved_law: the quoted text of a published rule version, which a
--               reviewer signed. Its figures may back a verified answer.
-- secondary:    crawled or uploaded text no reviewer has approved. It can
--               explain, but its figures never make a number pass Verify.
--
-- applies_to_ya already exists on chunk; the indexer now fills it, so a
-- passage about one year is not retrieved for another. Additive only.

alter table chunk add column if not exists trust text not null default 'secondary';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chunk_trust_check') then
    alter table chunk add constraint chunk_trust_check check (trust in ('approved_law', 'secondary'));
  end if;
end $$;

update chunk set trust = 'approved_law'
 where source_document_id is null and rule_key is not null and trust <> 'approved_law';

create index if not exists idx_chunk_ya on chunk using gin (applies_to_ya);
