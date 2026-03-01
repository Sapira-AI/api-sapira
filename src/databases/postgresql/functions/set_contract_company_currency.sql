CREATE OR REPLACE FUNCTION public.set_contract_company_currency()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Auto-populate company_currency from companies table if not provided
  IF NEW.company_currency IS NULL AND NEW.company_id IS NOT NULL THEN
    SELECT currency INTO NEW.company_currency
    FROM public.companies
    WHERE id = NEW.company_id;
  END IF;
  
  RETURN NEW;
END;
$function$;
