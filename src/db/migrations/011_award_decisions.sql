-- An award is an organizer decision tied to one frozen result revision.
-- Multiple rows with the same award_key and place are an explicit shared award.
create table award_decision (
  id text primary key,
  event_id text not null,
  publication_revision integer not null,
  award_key text not null check (length(award_key) between 3 and 80),
  project_id text not null,
  decision_type text not null check (decision_type in ('placement', 'special')),
  place integer check (place between 1 and 100),
  public_summary text not null check (length(public_summary) between 8 and 500),
  internal_reason text not null check (length(internal_reason) between 8 and 1000),
  actor_id text references account(id),
  decided_at integer not null,
  unique (event_id, publication_revision, award_key, project_id),
  foreign key (event_id, publication_revision) references result_publication(event_id, revision),
  foreign key (event_id, project_id) references project(event_id, id),
  check ((decision_type = 'placement' and place is not null) or
         (decision_type = 'special' and place is null))
) strict;
