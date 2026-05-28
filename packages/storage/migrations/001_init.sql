create table if not exists records (
  record_hash text primary key,
  short_signature text unique not null,

  format_version text not null,
  session_id uuid not null,

  producer_id text not null,
  producer_version text not null,
  producer_capabilities jsonb not null,

  capture_context jsonb null,

  event_count integer not null,
  duration_ms integer not null,
  final_text_hash text not null,
  final_text_length integer not null,

  created_client_t timestamptz null,
  ingested_server_t timestamptz not null,

  parent_record_hash text null references records(record_hash),

  attestations jsonb not null default '[]',
  events jsonb not null,

  created_at timestamptz not null default now(),

  constraint records_hash_prefix check (record_hash like 'b3:%'),
  constraint records_final_text_hash_prefix check (final_text_hash like 'b3:%')
);

create index if not exists records_parent_record_hash_idx on records(parent_record_hash);

create table if not exists record_stats (
  record_hash text primary key references records(record_hash) on delete cascade,

  insert_op_count integer not null,
  delete_op_count integer not null,
  replace_op_count integer not null,

  typed_event_count integer not null,
  paste_event_count integer not null,
  cut_event_count integer not null,
  drop_event_count integer not null,
  ime_event_count integer not null,
  autocomplete_event_count integer not null,
  programmatic_event_count integer not null,
  unknown_source_count integer not null,

  inserted_codepoints_total integer not null,
  deleted_codepoints_total integer not null,
  largest_atomic_insert_codepoints integer not null,

  inter_event_delay_min_ms integer null,
  inter_event_delay_p50_ms integer null,
  inter_event_delay_p90_ms integer null,
  inter_event_delay_p95_ms integer null,
  inter_event_delay_p99_ms integer null,
  inter_event_delay_max_ms integer null,

  active_time_ms integer not null,
  idle_time_ms integer not null,
  long_pause_count integer not null,

  delay_histogram jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists analysis_results (
  id uuid primary key,
  record_hash text not null references records(record_hash) on delete cascade,

  analyzer_id text not null,
  analyzer_version text not null,
  applicable boolean not null,

  measures jsonb not null,
  human_range jsonb null,
  explanation text not null,

  created_at timestamptz not null default now(),

  unique(record_hash, analyzer_id, analyzer_version)
);

create index if not exists analysis_results_record_hash_idx on analysis_results(record_hash);
