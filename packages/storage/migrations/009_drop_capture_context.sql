-- Migration 008 emptied capture_context and no release since 0.4.2 reads or
-- writes it, so the column itself goes. Records describe only the writing
-- process.
alter table records drop column capture_context;
