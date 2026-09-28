-- Records describe only the writing process. Remove everything earlier
-- producers sent about where the text was written: the page URL and title,
-- the public label, the site and the Emacs buffer. None of it is part of the
-- record hash, so every record still verifies.
update records set capture_context = null where capture_context is not null;
update record_uploads set manifest = manifest - 'capture_context' where manifest ? 'capture_context';
