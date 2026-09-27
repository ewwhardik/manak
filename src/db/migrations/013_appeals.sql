-- Participant appeals are private until an organizer publishes a resolution.
create table appeal (
  id text primary key,
  event_id text not null,
  project_id text not null,
  opened_by text not null references account(id),
  publication_revision integer not null,
  private_message text not null check (length(private_message) between 8 and 2000),
  public_summary text not null,
  state text not null check (state in ('open','accepted','rejected')),
  opened_at integer not null,
  deadline_at integer not null,
  resolved_at integer,
  internal_reason text,
  resolved_by text references account(id),
  correction_revision integer,
  foreign key (event_id, project_id) references project(event_id, id),
  foreign key (event_id, publication_revision) references result_publication(event_id, revision)
) strict;
create unique index appeal_per_publication on appeal(event_id, project_id, opened_by, publication_revision);
