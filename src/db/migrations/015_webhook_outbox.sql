-- Operational subscriptions contain no signing secrets. New notifications commit
-- with the ledger entry and therefore with the originating business transaction.
create table webhook_subscription (
  destination text primary key,
  event_id text not null references event(id),
  cursor integer not null default 0,
  cursor_hash text not null default ''
) strict;
create table webhook_delivery (
  destination text not null references webhook_subscription(destination),
  sequence integer not null references ledger(seq),
  status text not null default 'queued' check(status in ('queued','delivered')),
  attempts integer not null default 0,
  last_attempt_at integer,
  delivered_at integer,
  status_code integer,
  last_error text,
  primary key(destination, sequence)
) strict;
create trigger webhook_ledger_outbox after insert on ledger begin
  insert into webhook_delivery(destination, sequence)
  select destination, new.seq from webhook_subscription where event_id = new.event_id;
end;
