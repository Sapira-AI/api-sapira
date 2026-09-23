-- Job pg_cron auto-renew-contract-items (0 2 * * *). Se aplica con el rol postgres:
-- cron.schedule hace upsert por (jobname, username), así que otro rol crearía un job paralelo.

SELECT cron.schedule('auto-renew-contract-items', '0 2 * * *', $cron$SELECT public.process_auto_renewals(90)$cron$);
