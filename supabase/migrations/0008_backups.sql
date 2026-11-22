-- =====================================================================
-- Mushroom Farm app — 0008 nightly backup
-- Run after 0007_reports.sql. Then run supabase/schedule/2-backup-timer.sql.
--
-- Every night the "report" Edge Function copies every table into one Excel
-- file, keeps the last 30 in Supabase Storage, and on Sundays emails it to
-- the report email list. (For a full off-site copy, see docs/DEPLOYMENT.md,
-- "GitHub backup".)
-- =====================================================================

create function backup_tick() returns text
language plpgsql security definer set search_path = public as $$
declare
  sec     app_secrets;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_id    uuid;
begin
  if exists (select 1 from report_runs where kind = 'backup' and from_date = v_today
             and (status = 'done' or (status = 'running' and created_at > now() - interval '30 minutes'))) then
    return 'already done';
  end if;
  if (select count(*) from report_runs where kind = 'backup' and from_date = v_today) >= 3 then
    return 'gave up after 3 tries';
  end if;
  select * into sec from app_secrets where id;
  if sec.report_function_url is null or sec.cron_secret is null then return 'not set up'; end if;

  insert into report_runs (kind, from_date, to_date, status) values ('backup', v_today, v_today, 'running')
  returning id into v_id;
  perform net.http_post(
    url := sec.report_function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', sec.cron_secret),
    body := jsonb_build_object('run_id', v_id, 'date', v_today, 'kind', 'backup'),
    timeout_milliseconds := 120000);
  return 'sent';
end $$;

revoke execute on function backup_tick() from public, anon, authenticated;
