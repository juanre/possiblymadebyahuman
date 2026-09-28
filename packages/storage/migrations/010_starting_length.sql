-- Where each record's document length starts: 0 for a record that starts
-- empty, or a continuation's parent final length (null when that is unknown).
-- Every record stored before this migration started empty.
alter table record_stats add column starting_length integer default 0;
