alter table records
  add column if not exists text_binding jsonb null;

alter table records
  add constraint records_text_binding_object
  check (text_binding is null or jsonb_typeof(text_binding) = 'object');
