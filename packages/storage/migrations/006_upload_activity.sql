-- Unfinalized uploads record their last activity so abandoned staging can be
-- deleted, and their received event bytes so one upload stays bounded.
alter table record_uploads
  add column updated_at timestamptz not null default now(),
  add column received_bytes bigint not null default 0 check (received_bytes >= 0);

create index record_uploads_unfinalized_updated_idx on record_uploads(updated_at)
  where finalized_record_hash is null;
