-- Event-specific signal thresholds and explicit human review decisions.
create table abuse_policy (
  event_id text primary key references event(id) on delete cascade,
  pattern_cosine real not null check (pattern_cosine between 0.5 and 1),
  shared_origin_cosine real not null check (shared_origin_cosine between 0.5 and 1),
  high_risk_threshold integer not null check (high_risk_threshold between 0 and 100),
  updated_at integer not null
) strict, without rowid;

create table abuse_review (
  event_id text not null references event(id) on delete cascade,
  signal_key text not null,
  state text not null check (state in ('investigating', 'benign', 'confirmed')),
  reason text not null check (length(reason) between 8 and 1000),
  actor_id text references account(id),
  updated_at integer not null,
  primary key (event_id, signal_key)
) strict, without rowid;

-- Keep raw votes immutable. A reviewed discount is applied only in aggregation.
create table vote_discount (
  event_id text not null,
  voter_hash text not null,
  discount_percent integer not null check (discount_percent between 0 and 100),
  reason text not null check (length(reason) between 5 and 256),
  actor_id text references account(id),
  updated_at integer not null,
  primary key (event_id, voter_hash),
  foreign key (event_id, voter_hash) references voter(event_id, token_hash) on delete cascade
) strict, without rowid;
