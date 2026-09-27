-- Additive content upgrade. Existing submissions remain valid and keep their history.
alter table project add column tagline text not null default '' check(length(tagline) <= 200);
alter table project add column description text not null default '' check(length(description) <= 20000);
alter table project add column thumbnail_url text not null default '' check(length(thumbnail_url) <= 2048);
alter table project add column video_url text not null default '' check(length(video_url) <= 2048);
alter table project add column image_urls text not null default '' check(length(image_urls) <= 16000);
alter table project add column tech_tags text not null default '' check(length(tech_tags) <= 1000);
alter table project add column answers text not null default '' check(length(answers) <= 12000);
alter table event add column prizes text not null default '' check(length(prizes) <= 4000);
alter table event add column questions text not null default '' check(length(questions) <= 4000);
