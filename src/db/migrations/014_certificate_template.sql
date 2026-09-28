-- Organizer draft. The first issued batch copies it into signed certificate payloads.
create table certificate_template (
  event_id text primary key references event(id) on delete cascade,
  presentation text not null check (json_valid(presentation)),
  logo_data_url text,
  updated_at integer not null
) strict, without rowid;
