create table mfa_totp (
  account_id     text    primary key references account (id) on delete cascade,
  secret         text    not null,
  backup_codes   text    not null,
  enabled_at     integer not null,
  last_used_step integer not null default 0
) strict;
