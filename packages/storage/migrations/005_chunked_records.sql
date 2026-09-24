-- Immutable event pages and resumable bounded publication. Legacy JSONB logs stay readable.
alter table records add column event_storage text not null default 'inline'
  check (event_storage in ('inline', 'chunks'));
alter table records add column observation_summary jsonb null;

create table record_uploads (
  upload_id uuid primary key,
  manifest jsonb not null,
  observation jsonb null,
  next_seq integer not null default 0,
  chain_tip text null,
  last_t bigint null,
  observed_length integer null default 0,
  analysis_state jsonb not null,
  finalized_record_hash text null references records(record_hash),
  published_owner boolean not null default false,
  created_at timestamptz not null default now()
);

create table record_event_chunks (
  upload_id uuid not null references record_uploads(upload_id),
  start_seq integer not null,
  end_seq integer not null,
  events jsonb not null,
  chain_tips text[] not null,
  primary key(upload_id, start_seq),
  check (start_seq >= 0 and end_seq > start_seq and end_seq - start_seq <= 4096),
  check (jsonb_array_length(events) = end_seq - start_seq),
  check (cardinality(chain_tips) = end_seq - start_seq)
);
create unique index record_uploads_finalized_idx on record_uploads(finalized_record_hash)
  where published_owner;

create table upload_delay_counts (
  upload_id uuid not null references record_uploads(upload_id),
  delay_ms bigint not null check (delay_ms >= 0),
  event_count integer not null check (event_count > 0),
  primary key(upload_id, delay_ms)
);
