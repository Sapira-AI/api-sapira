CREATE OR REPLACE FUNCTION public.update_revenue_schedule_monthly_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$

