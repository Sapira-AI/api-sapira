-- Job pg_cron check-overdue-invoices-daily (1 4 * * *). Se aplica con el rol postgres:
-- cron.schedule hace upsert por (jobname, username), así que otro rol crearía un job paralelo.

SELECT cron.schedule('check-overdue-invoices-daily', '1 4 * * *', $cron$SELECT public.cron_invoke_edge_function('check-overdue-invoices', 'POST')$cron$);
