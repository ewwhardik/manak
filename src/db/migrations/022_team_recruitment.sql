alter table team add column recruiting integer not null default 0 check (recruiting in (0, 1));
alter table team add column needed_skills text;
