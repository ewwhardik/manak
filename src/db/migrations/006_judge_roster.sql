-- Optional restrictions. No rows means unrestricted tracks and capacity.
create table judge_track (
  event_id text not null,
  judge_id text not null,
  track_key text not null,
  created_at integer not null,
  is_judge text generated always as ('judge') virtual,
  primary key (event_id, judge_id, track_key),
  foreign key (event_id, judge_id, is_judge)
    references membership(event_id, account_id, role) on delete cascade,
  foreign key (event_id, track_key) references track(event_id, key) on delete restrict
) strict, without rowid;

create table judge_capacity (
  event_id text not null,
  judge_id text not null,
  max_reviews integer not null check (max_reviews >= 0),
  updated_at integer not null,
  is_judge text generated always as ('judge') virtual,
  primary key (event_id, judge_id),
  foreign key (event_id, judge_id, is_judge)
    references membership(event_id, account_id, role) on delete cascade
) strict, without rowid;

create table judge_recusal (
  event_id text not null,
  judge_id text not null,
  project_id text not null,
  reason text not null check (length(reason) between 3 and 500),
  created_at integer not null,
  is_judge text generated always as ('judge') virtual,
  primary key (event_id, judge_id, project_id),
  foreign key (event_id, judge_id, is_judge)
    references membership(event_id, account_id, role) on delete cascade,
  foreign key (event_id, project_id) references project(event_id, id) on delete cascade
) strict, without rowid;
