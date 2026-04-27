CREATE OR REPLACE FUNCTION public.update_salesforce_opportunities_cache_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$

