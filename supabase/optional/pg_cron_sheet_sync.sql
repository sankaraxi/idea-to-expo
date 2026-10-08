-- =============================================================================
-- OPTIONAL: drive the Google Sheets worker from Supabase every minute.
--
-- Use this if your Vercel plan cannot run per-minute crons. Run it once in the
-- Supabase SQL editor after enabling the pg_cron and pg_net extensions
-- (Database → Extensions), replacing the two placeholders.
--
-- The worker also runs right after every evaluation/allocation (Next.js
-- `after()`) and from the admin Sync page, so this is the safety net that
-- guarantees failed jobs are retried even when nobody is using the portal.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('idea-to-expo-sheet-sync')
where exists (select 1 from cron.job where jobname = 'idea-to-expo-sheet-sync');

select cron.schedule(
  'idea-to-expo-sheet-sync',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR-APP.vercel.app/api/sync/process',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET', 'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);
