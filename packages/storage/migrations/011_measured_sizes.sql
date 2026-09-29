-- Totals over the edits whose sizes are known, and how many edits have an
-- unknown size, so a record with a few unknown edits still reports the rest.
-- Records stored earlier are totalled from their stored events.
alter table record_stats
  add column measured_inserted_codepoints integer null,
  add column measured_deleted_codepoints integer null,
  add column measured_largest_insert_codepoints integer null,
  add column unknown_size_edit_count integer not null default 0;

with stored_events as (
  select r.record_hash, e.value as event
  from records r
  cross join lateral jsonb_array_elements(r.events) e
  where r.event_storage = 'inline'
  union all
  select r.record_hash, e.value as event
  from records r
  join record_uploads u on u.finalized_record_hash = r.record_hash and u.published_owner
  join record_event_chunks c on c.upload_id = u.upload_id
  cross join lateral jsonb_array_elements(c.events) e
  where r.event_storage = 'chunks'
), totals as (
  select record_hash,
    coalesce(sum((event->>'ins_len')::integer), 0) as inserted,
    coalesce(sum((event->>'del_len')::integer), 0) as deleted,
    coalesce(max((event->>'ins_len')::integer), 0) as largest,
    count(*) filter (where event->>'ins_len' is null or event->>'del_len' is null) as unknown
  from stored_events
  group by record_hash
)
update record_stats s
set measured_inserted_codepoints = t.inserted,
    measured_deleted_codepoints = t.deleted,
    measured_largest_insert_codepoints = t.largest,
    unknown_size_edit_count = t.unknown
from totals t
where s.record_hash = t.record_hash;
