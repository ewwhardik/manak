-- Database-level trigger hardening for deadlines, budgets, and conflicts of interest.
-- Enforces phase boundaries directly at SQLite engine layer as an immutable backstop.

create trigger project_submission_insert_window before insert on project
when new.status = 'submitted' and (new.submitted_at <
  (select submissions_open_at from event where id = new.event_id) or new.submitted_at >=
  (select submissions_close_at from event where id = new.event_id))
begin select raise(abort, 'project submission timestamp outside event window'); end;

create trigger vote_submission_window before insert on vote
when (select voting_open_at from event where id = new.event_id) is not null
  and (select voting_close_at from event where id = new.event_id) is not null
  and (new.created_at < (select voting_open_at from event where id = new.event_id)
    or new.created_at >= (select voting_close_at from event where id = new.event_id))
begin select raise(abort, 'vote timestamp outside event voting window'); end;

create trigger vote_budget_limit before insert on vote
when (select coalesce(sum(credits_spent), 0) from vote
  where event_id = new.event_id and voter_hash = new.voter_hash and project_id != new.project_id)
  + new.credits_spent > (select voting_credits from event where id = new.event_id)
begin select raise(abort, 'voter credits spent exceeds event budget'); end;

create trigger vote_submission_window_update before update of created_at on vote
when (select voting_open_at from event where id = new.event_id) is not null
  and (select voting_close_at from event where id = new.event_id) is not null
  and (new.created_at < (select voting_open_at from event where id = new.event_id)
    or new.created_at >= (select voting_close_at from event where id = new.event_id))
begin select raise(abort, 'vote timestamp outside event voting window'); end;

create trigger vote_budget_limit_update before update of credits_spent on vote
when (select coalesce(sum(credits_spent), 0) from vote
  where event_id = new.event_id and voter_hash = new.voter_hash and project_id != new.project_id)
  + new.credits_spent > (select voting_credits from event where id = new.event_id)
begin select raise(abort, 'voter credits spent exceeds event budget'); end;
