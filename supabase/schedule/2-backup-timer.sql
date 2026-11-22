-- =====================================================================
-- Mushroom Farm app — switch on the nightly backup
-- Run ONCE in Supabase → SQL Editor, after 1-report-timer.sql and
-- after migrations/0008_backups.sql. Nothing to edit in this file.
-- =====================================================================

-- Every night at 2:00 am India time (20:30 UTC). Retries at 2:15 and 2:30 if it failed.
select cron.unschedule(jobid) from cron.job where jobname = 'farm-backup';
select cron.schedule('farm-backup', '30,45 20 * * *', $$ select public.backup_tick() $$);
select cron.unschedule(jobid) from cron.job where jobname = 'farm-backup-retry';
select cron.schedule('farm-backup-retry', '0 21 * * *', $$ select public.backup_tick() $$);

select jobname, schedule from cron.job order by jobname;
