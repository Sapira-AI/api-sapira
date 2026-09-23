-- Job pg_cron refresh-pending-renewals (0 6 * * *). Se aplica con el rol postgres:
-- cron.schedule hace upsert por (jobname, username), así que otro rol crearía un job paralelo.

SELECT cron.schedule('refresh-pending-renewals', '0 6 * * *', $cron$SELECT public.refresh_all_pending_renewals()$cron$);
