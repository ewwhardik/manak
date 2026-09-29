create table event_announcement (
  id         text    primary key,
  event_id   text    not null references event (id) on delete cascade,
  author_id  text    not null references account (id),
  title      text    not null,
  content    text    not null,
  pinned     integer not null default 0 check (pinned in (0, 1)),
  created_at integer not null,
  updated_at integer not null,
  check (length(title) between 1 and 200),
  check (length(content) between 1 and 10000)
) strict;

create index event_announcement_event_idx on event_announcement (event_id, pinned desc, created_at desc);
