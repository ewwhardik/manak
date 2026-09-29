-- Team join links are scoped to one team and replaceable by its current captain.
-- The code is a high-entropy, participant-scoped capability. It is kept only in this
-- private table so the captain can retrieve the current link after the POST/redirect/GET
-- cycle; it is never copied into the append-only audit ledger.
create table team_invite (
  event_id    text    not null,
  team_id     text    not null,
  code        text    not null unique,
  generation  integer not null check (generation >= 1),
  updated_at  integer not null,
  primary key (event_id, team_id),
  foreign key (event_id, team_id) references team (event_id, id) on delete cascade,
  check (length(code) = 43),
  check (code not glob '*[^A-Za-z0-9_-]*')
) strict, without rowid;
