-- Issuance is an immutable event snapshot, not a side effect of downloading.
create table certificate_batch (
  event_id text primary key references event(id),
  issued_at integer not null,
  report text not null check (json_valid(report))
) strict, without rowid;
