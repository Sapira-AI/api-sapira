CREATE OR REPLACE FUNCTION public.validate_contract_currency_consistency()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Check if contract items have consistent currency with contract
  IF EXISTS (
    SELECT 1 FROM public.contract_items ci 
    WHERE ci.contract_id = NEW.id 
      AND ci.currency != NEW.contract_currency
  ) THEN
    RAISE EXCEPTION 'Contract currency (%) must match all contract items currency', NEW.contract_currency;
  END IF;
  
  RETURN NEW;
END;
$function$;
