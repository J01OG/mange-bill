-- =====================================================================
-- Mushroom Farm app — switch on the daily report timer
-- Run ONCE in Supabase → SQL Editor, AFTER the database setup and AFTER the
-- "report" Edge Function is deployed. (This file is Supabase-only, so it
-- lives outside the migrations folder.)
--
-- BEFORE RUNNING: replace YOUR-PROJECT-ID below (in step 2) with your project id,
-- the part before ".supabase.co" in your Project URL.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Private storage folder for the Excel files (owner can download them in the app).
insert into storage.buckets (id, name, public) values ('reports', 'reports', false)
on conflict (id) do nothing;

drop policy if exists "owner reads reports" on storage.objects;
create policy "owner reads reports" on storage.objects for select to authenticated
  using (bucket_id = 'reports' and public.is_owner());

-- 2. Where the timer sends its request, plus a random password for it.
update public.app_secrets set
  report_function_url = 'https://YOUR-PROJECT-ID.supabase.co/functions/v1/report',
  cron_secret = coalesce(cron_secret, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
where id;

-- 3. Check every 15 minutes; the report goes out at the time set in the app.
select cron.unschedule(jobid) from cron.job where jobname = 'farm-report-tick';
select cron.schedule('farm-report-tick', '*/15 * * * *', $$ select public.report_tick() $$);

-- 4. Copy the long value shown below into the Edge Function secret CRON_SECRET (see guide).
select cron_secret as "Copy this into CRON_SECRET" from public.app_secrets;
