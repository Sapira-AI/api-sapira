CREATE OR REPLACE FUNCTION public.set_contract_item_end_date()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.start_date IS NOT NULL AND NEW.term_months IS NOT NULL THEN
    NEW.end_date := ((NEW.start_date + (NEW.term_months || ' months')::interval) - interval '1 day')::date;
  END IF;
  RETURN NEW;
END;
$function$

