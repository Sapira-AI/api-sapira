CREATE OR REPLACE FUNCTION public.trg_set_updated_at_accounting_period_cutoff()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $function$

