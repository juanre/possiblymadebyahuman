-- Missing capture measurements are unknown, not zero. Existing cached values
-- stay intact; API read projections derive accurate values from stored events.
alter table record_stats
  alter column inserted_codepoints_total drop not null,
  alter column deleted_codepoints_total drop not null,
  alter column largest_atomic_insert_codepoints drop not null;
