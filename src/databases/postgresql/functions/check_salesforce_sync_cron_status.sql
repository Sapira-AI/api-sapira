CREATE OR REPLACE FUNCTION public.check_salesforce_sync_cron_status()
 RETURNS TABLE(jobname text, schedule text, active boolean, last_run timestamp with time zone, next_run timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT 
    j.jobname::TEXT,
    j.schedule::TEXT,
    j.active,
    j.last_run,
    j.next_run
  FROM cron.job j
  WHERE j.jobname = 'salesforce-daily-sync';
END;
$function$

