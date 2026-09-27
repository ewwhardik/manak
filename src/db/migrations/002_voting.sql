alter table event add column voting_open_at integer;
alter table event add column voting_close_at integer;
alter table event add column voting_mode text not null default 'off'
  check (voting_mode in ('off', 'open', 'account'));
alter table event add column voting_credits integer not null default 100
  check (voting_credits between 1 and 100000);

create table voter (
  token_hash  text primary key,
  event_id    text not null references event (id) on delete cascade,
  account_id  text references account (id) on delete set null,
  fingerprint text not null,
  credits     integer not null,
  created_at  integer not null,
  expires_at  integer not null,
  unique (event_id, fingerprint),
  unique (event_id, token_hash),
  check (length(token_hash) = 64 and token_hash not glob '*[^0-9a-f]*'),
  check (credits >= 0),
  check (expires_at > created_at)
) strict;

create table vote (
  event_id     text not null,
  voter_hash   text not null,
  project_id   text not null,
  credits_spent integer not null,
  weight       integer not null,
  created_at   integer not null,
  primary key (event_id, voter_hash, project_id),
  foreign key (event_id, voter_hash) references voter (event_id, token_hash) on delete cascade,
  foreign key (event_id, project_id) references project (event_id, id) on delete cascade,
  check (credits_spent >= 1),
  check (weight >= 1)
) strict, without rowid;

create index voter_by_event on voter (event_id, created_at);
create index vote_by_project on vote (event_id, project_id);
