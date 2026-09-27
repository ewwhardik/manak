-- The last successful draft edit, distinct from creation and submission.
alter table project add column saved_at integer;
update project set saved_at = created_at;
