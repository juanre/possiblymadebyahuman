-- Operator removal of abusive records. A continuation keeps the parent hash it
-- signed after its parent is removed, so the reference is no longer a foreign key.
alter table records drop constraint records_parent_record_hash_fkey;

-- Removed hashes are private operator state, never listed publicly.
create table removed_records (
  record_hash text primary key check (record_hash like 'b3:%'),
  removed_at timestamptz not null default now()
);

-- Every publication path inserts into records. Removal takes the same
-- per-hash lock, so a removal and a publication of one hash serialize.
create function reject_removed_record() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.record_hash, 0));
  if exists (select 1 from removed_records where record_hash = new.record_hash) then
    raise exception 'record % was removed', new.record_hash using errcode = 'PM410';
  end if;
  return new;
end $$;

create trigger records_reject_removed before insert on records
  for each row execute function reject_removed_record();
