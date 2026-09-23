-- Job pg_cron salesforce-daily-sync (1 4 * * *). Se aplica con el rol postgres:
-- cron.schedule hace upsert por (jobname, username), así que otro rol crearía un job paralelo.

SELECT cron.schedule('salesforce-daily-sync', '1 4 * * *', $cron$SELECT public.cron_invoke_edge_function('salesforce-daily-sync', 'GET')$cron$);
