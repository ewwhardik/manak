create table api_token (
  id text primary key,
  account_id text not null references account(id),
  event_id text not null references event(id),
  label text not null,
  scope text not null check(scope in ('read:projects','read:results','write:projects','write:judging')),
  token_hash text not null unique check(length(token_hash) = 64),
  created_at integer not null,
  expires_at integer not null,
  revoked_at integer,
  check(expires_at > created_at)
) strict;
create index api_token_account on api_token(account_id, created_at);
