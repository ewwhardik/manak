-- Preserve historical judging evidence when a role is revoked. Existing rows are active.
alter table membership add column active integer not null default 1 check (active in (0, 1));
alter table membership add column revoked_at integer;
alter table membership add column evidence_excluded_at integer;
alter table membership add column evidence_exclusion_reason text;

-- A published report is a byte-stable decision. Corrections append a revision.
create table result_publication (
  event_id text not null references event(id) on delete cascade,
  revision integer not null check (revision > 0),
  issued_at integer not null,
  rubric_version integer,
  algorithm text not null,
  options text not null check (json_valid(options)),
  evidence_digest text not null,
  ledger_head text not null,
  report text not null check (json_valid(report)),
  reason text not null,
  superseded_at integer,
  primary key (event_id, revision)
) strict, without rowid;

alter table certificate_batch add column publication_revision integer;
alter table certificate_batch add column publication_digest text;
