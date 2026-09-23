-- Elapsed milliseconds must span long pauses without changing record content.
-- Calendar timestamps already use timestamptz; counts retain their old bounds.
alter table records
  alter column duration_ms type bigint;

alter table record_stats
  alter column inter_event_delay_min_ms type bigint,
  alter column inter_event_delay_p50_ms type bigint,
  alter column inter_event_delay_p90_ms type bigint,
  alter column inter_event_delay_p95_ms type bigint,
  alter column inter_event_delay_p99_ms type bigint,
  alter column inter_event_delay_max_ms type bigint,
  alter column active_time_ms type bigint,
  alter column idle_time_ms type bigint;
