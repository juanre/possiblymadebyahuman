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

  created_client_t timestamptz null,
  ingested_server_t timestamptz not null,

  parent_record_hash text null references records(record_hash),

  attestations jsonb not null default '[]',
  events jsonb not null,

  created_at timestamptz not null default now(),
  observation_state text not null default 'not_requested',

  constraint records_hash_prefix check (record_hash like 'b3:%'),
  constraint records_observation_state check (observation_state in ('not_requested', 'unobserved'))
);

create index if not exists records_parent_record_hash_idx on records(parent_record_hash);

create table if not exists record_stats (
  record_hash text primary key references records(record_hash) on delete cascade,

  observed_final_length integer null,

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

create table if not exists observed_sessions (
  observed_session_id uuid primary key,
  token_hash text not null,
  finalized_record_hash text null references records(record_hash),
  observation_state text null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz null,

  constraint observed_sessions_observation_state check (
    observation_state is null or observation_state in ('observed', 'partial')
  )
);

create index if not exists observed_sessions_finalized_record_hash_idx on observed_sessions(finalized_record_hash);

create table if not exists observed_checkpoints (
  checkpoint_id uuid primary key,
  observed_session_id uuid not null references observed_sessions(observed_session_id) on delete cascade,
  event_count integer not null,
  chain_tip text not null,
  observed_at timestamptz not null default now(),

  constraint observed_checkpoints_event_count_positive check (event_count >= 1),
  constraint observed_checkpoints_chain_tip_format check (chain_tip ~ '^b3:[0-9a-f]{64}$'),
  unique(observed_session_id, event_count)
);

create index if not exists observed_checkpoints_session_order_idx on observed_checkpoints(observed_session_id, event_count, observed_at);
