-- Publication notes may contain private judge review details. Existing notes stay
-- internal; the public history receives a safe summary without copying old text.
alter table result_publication add column public_summary text not null default 'Results revision';
update result_publication set public_summary = case
  when revision = 1 then 'Initial results publication'
  else 'Results corrected'
end;
