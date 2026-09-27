-- Signed, append-only certificate status records. Replacement recipients stay private.
create table certificate_correction (
  id text primary key,
  event_id text not null references event(id) on delete cascade,
  serial text not null,
  action text not null check (action in ('revoke', 'supersede')),
  replacement_serial text,
  replacement_certificate text check (replacement_certificate is null or json_valid(replacement_certificate)),
  publication_revision integer not null,
  publication_digest text not null,
  reason text not null check (length(reason) between 8 and 1000),
  issued_at integer not null,
  issuer_key_id text not null,
  public_key_pem text not null,
  signature text not null,
  check ((action = 'revoke' and replacement_serial is null and replacement_certificate is null)
    or (action = 'supersede' and replacement_serial is not null and replacement_certificate is not null))
) strict;
create index certificate_correction_by_event on certificate_correction(event_id, serial, issued_at);
