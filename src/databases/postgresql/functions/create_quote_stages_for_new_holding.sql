CREATE OR REPLACE FUNCTION public.create_quote_stages_for_new_holding()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  BEGIN
    PERFORM create_default_quote_stages_for_holding(NEW.id);
    RETURN NEW;
  END;
  $function$

