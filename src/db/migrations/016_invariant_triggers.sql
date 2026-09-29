-- Cross-row safeguards for writes made outside the repositories. The application
-- still checks the current clock and produces useful errors; SQLite checks the
-- recorded timestamps and relationships atomically with the row being written.
create trigger project_submission_window before update of status, submitted_at on project
when new.status = 'submitted' and (new.submitted_at <
  (select submissions_open_at from event where id = new.event_id) or new.submitted_at >=
  (select submissions_close_at from event where id = new.event_id))
begin select raise(abort, 'project submission timestamp outside event window'); end;

create trigger ballot_submission_window_insert before insert on ballot
when new.submitted_at is not null and (new.submitted_at <
  (select judging_open_at from event where id = new.event_id) or new.submitted_at >=
  (select judging_close_at from event where id = new.event_id))
begin select raise(abort, 'ballot timestamp outside judging window'); end;

create trigger ballot_submission_window_update before update of submitted_at on ballot
when new.submitted_at is not null and (new.submitted_at <
  (select judging_open_at from event where id = new.event_id) or new.submitted_at >=
  (select judging_close_at from event where id = new.event_id))
begin select raise(abort, 'ballot timestamp outside judging window'); end;

create trigger comparison_window before insert on comparison
when new.decided_at < (select judging_open_at from event where id = new.event_id)
  or new.decided_at >= (select judging_close_at from event where id = new.event_id)
begin select raise(abort, 'comparison timestamp outside judging window'); end;

-- Rubric criteria are immutable once scored; a correction creates a new version.
create trigger criterion_scored_insert before insert on criterion
when exists (select 1 from score where event_id = new.event_id
  and rubric_version = new.rubric_version)
begin select raise(abort, 'scored rubric criteria are frozen'); end;
create trigger criterion_scored_update before update on criterion
when exists (select 1 from score where event_id = old.event_id
  and rubric_version = old.rubric_version)
begin select raise(abort, 'scored rubric criteria are frozen'); end;
create trigger criterion_scored_delete before delete on criterion
when exists (select 1 from score where event_id = old.event_id
  and rubric_version = old.rubric_version)
begin select raise(abort, 'scored rubric criteria are frozen'); end;

create trigger score_range_insert before insert on score
when not exists (select 1 from criterion where event_id = new.event_id
  and rubric_version = new.rubric_version and key = new.criterion_key
  and new.value between min_score and max_score)
begin select raise(abort, 'score outside criterion range'); end;
create trigger score_range_update before update of value on score
when not exists (select 1 from criterion where event_id = new.event_id
  and rubric_version = new.rubric_version and key = new.criterion_key
  and new.value between min_score and max_score)
begin select raise(abort, 'score outside criterion range'); end;

create trigger assignment_team_conflict before insert on assignment
when exists (select 1 from membership j where j.event_id = new.event_id
  and j.account_id = new.judge_id and j.role = 'judge' and j.active = 1)
  and exists (select 1 from team_member m join project p
  on p.event_id = m.event_id and p.team_id = m.team_id
  where p.event_id = new.event_id and p.id = new.project_id and m.account_id = new.judge_id)
begin select raise(abort, 'judge cannot review own team'); end;
create trigger ballot_team_conflict before insert on ballot
when exists (select 1 from membership j where j.event_id = new.event_id
  and j.account_id = new.judge_id and j.role = 'judge' and j.active = 1)
  and exists (select 1 from team_member m join project p
  on p.event_id = m.event_id and p.team_id = m.team_id
  where p.event_id = new.event_id and p.id = new.project_id and m.account_id = new.judge_id)
begin select raise(abort, 'judge cannot review own team'); end;
create trigger comparison_team_conflict before insert on comparison
when exists (select 1 from membership j where j.event_id = new.event_id
  and j.account_id = new.judge_id and j.role = 'judge' and j.active = 1)
  and exists (select 1 from team_member m join project p
  on p.event_id = m.event_id and p.team_id = m.team_id
  where p.event_id = new.event_id and p.id in (new.left_id, new.right_id)
    and m.account_id = new.judge_id)
begin select raise(abort, 'judge cannot compare own team'); end;
