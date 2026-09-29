-- A collision is held for human review, never deleted. An organizer can clear a
-- distinct project or confirm the quarantine; the original stays eligible.
alter table project add column duplicate_of text references project(id);
alter table project add column duplicate_reason text;
alter table project add column duplicate_decision text
  check (duplicate_decision in ('pending', 'confirmed', 'cleared'));
create index project_duplicate_triage on project(event_id, duplicate_decision, duplicate_of);
create trigger project_duplicate_event before update of duplicate_of on project
when new.duplicate_of is not null and not exists
  (select 1 from project p where p.id = new.duplicate_of and p.event_id = new.event_id
    and p.id <> new.id)
begin select raise(abort, 'duplicate reference must be an earlier project in this event'); end;
