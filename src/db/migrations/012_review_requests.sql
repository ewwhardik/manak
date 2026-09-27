-- Targeted extra rubric reviews are organizer decisions, separate from model output.
create table review_request (
  id text primary key,
  event_id text not null,
  project_id text not null,
  judge_id text not null references account(id),
  reason_code text not null check (reason_code in ('coverage','fragility','appeal','other')),
  internal_reason text not null check (length(internal_reason) between 8 and 500),
  priority integer not null check (priority between 1 and 3),
  due_at integer,
  state text not null check (state in ('open','cancelled')),
  created_at integer not null,
  cancelled_at integer,
  foreign key (event_id, project_id) references project(event_id, id)
) strict;
create unique index review_request_active on review_request(event_id, project_id, judge_id)
  where state = 'open';
